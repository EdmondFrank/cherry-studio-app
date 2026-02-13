import { messageDatabase } from '@database'
import { t } from 'i18next'
import { isEmpty, takeRight } from 'lodash'

import LegacyAiProvider from '@/aiCore'
import type { CompletionsParams } from '@/aiCore/legacy/middleware/schemas'
import type { AiSdkMiddlewareConfig } from '@/aiCore/middleware/AiSdkMiddlewareBuilder'
import { buildStreamTextParams } from '@/aiCore/prepareParams'
import { isDedicatedImageGenerationModel, isEmbeddingModel } from '@/config/models'
import i18n from '@/i18n'
import { loggerService } from '@/services/LoggerService'
import type { Assistant, FetchChatCompletionParams, Model, Provider } from '@/types/assistant'
import { ChunkType } from '@/types/chunk'
import type { MCPServer } from '@/types/mcp'
import type { SdkModel } from '@/types/sdk'
import type { MCPTool } from '@/types/tool'
import { isPromptToolUse, isSupportedToolUse } from '@/utils/mcpTool'
import { findFileBlocks, getMainTextContent } from '@/utils/messageUtils/find'
import { hasApiKey } from '@/utils/providerUtils'

import AiProviderNew from '../aiCore/index_new'
import { assistantService, getDefaultAssistant, getDefaultModel } from './AssistantService'
import { mcpService } from './McpService'
import { getAssistantProvider } from './ProviderService'
import type { StreamProcessorCallbacks } from './StreamProcessingService'
import { createStreamProcessor } from './StreamProcessingService'
import { topicService } from './TopicService'

const logger = loggerService.withContext('fetchChatCompletion')

function validateTopicName(name: string | null | undefined, currentName: string): string | null {
  if (!name || typeof name !== 'string') {
    return null
  }

  const trimmed = name.trim()

  if (trimmed.length === 0) {
    return null
  }

  const cleaned = trimmed
    .replace(/[.,，：:""''''""''【】\[\]{}()（）<>~!@#$%^&*+=|-]/g, '')
    .replace(/\s+/g, ' ')

  const isChinese = /[\u4e00-\u9fa5]/.test(cleaned)
  const maxLength = isChinese ? 20 : 30

  if (cleaned.length > maxLength) {
    return null
  }

  return cleaned
}

export async function fetchTopicNaming(topicId: string, regenerate: boolean = false) {
  logger.info('Fetching topic naming...')
  const topic = await topicService.getTopic(topicId)
  const messages = await messageDatabase.getMessagesByTopicId(topicId)

  if (!topic) {
    logger.error(`[fetchTopicNaming] Topic with ID ${topicId} not found.`)
    return
  }

  const originalName = topic.name

  if (originalName !== t('topics.new_topic') && !regenerate) {
    return
  }

  let callbacks: StreamProcessorCallbacks = {}

  callbacks = {
    onTextComplete: async finalText => {
      const validatedName = validateTopicName(finalText, originalName)
      if (validatedName) {
        await topicService.updateTopic(topicId, { name: validatedName })
      } else {
        logger.warn(`[fetchTopicNaming] Invalid AI response, keeping original name: ${originalName}`)
      }
    }
  }
  const streamProcessorCallbacks = createStreamProcessor(callbacks)
  const quickAssistant = await assistantService.getAssistant('quick')

  if (!quickAssistant) {
    logger.error('[fetchTopicNaming] Quick assistant not found')
    return
  }

  const contextMessages = takeRight(messages, 5)

  if (contextMessages.length === 0) {
    logger.warn('[fetchTopicNaming] No messages found for topic naming')
    return
  }

  const structuredMessages = await Promise.all(
    contextMessages.map(async message => {
      const mainText = await getMainTextContent(message)
      const truncatedText = mainText.length > 500 ? mainText.substring(0, 500) + '...' : mainText
      const fileBlocks = await findFileBlocks(message)
      const fileList = fileBlocks.map(block => block.file.origin_name)

      return {
        role: message.role,
        content: truncatedText,
        files: fileList.length > 0 ? fileList : undefined
      }
    })
  )

  const conversation = JSON.stringify(structuredMessages)

  const provider = await getAssistantProvider(quickAssistant)

  if (!provider) {
    logger.error('[fetchTopicNaming] Provider not found for quick assistant', {
      assistantId: quickAssistant.id,
      providerId: quickAssistant.providerId
    })
    return
  }

  if (!hasApiKey(provider)) {
    logger.error('[fetchTopicNaming] Provider API key missing', {
      providerId: provider.id,
      providerType: provider.type
    })
    return
  }

  const aiSdkParams = {
    system: quickAssistant.prompt,
    prompt: conversation
  }
  const modelId = topic.model || quickAssistant.defaultModel || getDefaultModel()

  if (!modelId) {
    logger.error('[fetchTopicNaming] Model ID not found', {
      topicModel: topic.model,
      assistantDefaultModel: quickAssistant.defaultModel
    })
    return
  }

  const model = typeof modelId === 'string' ? { id: modelId, name: modelId } : modelId

  const middlewareConfig: AiSdkMiddlewareConfig = {
    streamOutput: false,
    model: model,
    provider: provider,
    enableReasoning: false,
    isPromptToolUse: false,
    isSupportedToolUse: false,
    isImageGenerationEndpoint: false,
    enableWebSearch: false,
    enableGenerateImage: false,
    enableUrlContext: false,
    mcpTools: []
  }

  const assistantForRequest: Assistant = {
    ...quickAssistant,
    defaultModel: model,
    model: model
  }

  const AI = new AiProviderNew(model, provider)

  try {
    const result = await AI.completions(model.id, aiSdkParams, {
      ...middlewareConfig,
      assistant: assistantForRequest,
      topicId,
      callType: 'summary'
    })

    const rawText = result.getText()

    if (!rawText || rawText.trim().length === 0) {
      logger.error('[fetchTopicNaming] Empty response from AI', {
        topicId,
        modelId: model.id,
        providerType: provider.type,
        messageCount: contextMessages.length
      })
      return
    }

    const validatedName = validateTopicName(rawText, originalName)

    if (validatedName) {
      await topicService.updateTopic(topicId, { name: validatedName })
    } else {
      logger.warn(`[fetchTopicNaming] Validation failed for AI response: "${rawText}", keeping original: ${originalName}`)
    }
  } catch (error) {
    logger.error('[fetchTopicNaming] Error during topic naming:', error as Error, {
      topicId,
      modelId: model.id,
      providerType: provider?.type,
      messageCount: contextMessages.length,
      assistantId: quickAssistant.id,
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined
    })
  }
}

export async function fetchChatCompletion({
  messages,
  prompt,
  assistant,
  options,
  onChunkReceived,
  topicId,
  uiMessages
}: FetchChatCompletionParams) {
  const AI = new AiProviderNew(assistant.model || getDefaultModel())
  const provider = AI.getActualProvider()

  const mcpTools: MCPTool[] = []

  onChunkReceived({ type: ChunkType.LLM_RESPONSE_CREATED })

  if (isPromptToolUse(assistant) || isSupportedToolUse(assistant)) {
    mcpTools.push(...(await fetchAssistantMcpTools(assistant)))
  }

  if (prompt) {
    messages = [
      {
        role: 'user',
        content: prompt
      }
    ]
  }

  const {
    params: aiSdkParams,
    modelId,
    capabilities,
    webSearchPluginConfig
  } = await buildStreamTextParams(messages, assistant, provider, {
    mcpTools: mcpTools,
    webSearchProviderId: assistant.webSearchProviderId,
    requestOptions: options
  })

  const middlewareConfig: AiSdkMiddlewareConfig = {
    streamOutput: assistant.settings?.streamOutput ?? true,
    onChunk: onChunkReceived,
    model: assistant.model,
    enableReasoning: capabilities.enableReasoning,
    isPromptToolUse: isPromptToolUse(assistant),
    isSupportedToolUse: isSupportedToolUse(assistant),
    isImageGenerationEndpoint: isDedicatedImageGenerationModel(assistant.model || getDefaultModel()),
    enableWebSearch: capabilities.enableWebSearch,
    enableGenerateImage: capabilities.enableGenerateImage,
    enableUrlContext: capabilities.enableUrlContext,
    mcpTools,
    uiMessages,
    webSearchPluginConfig
  }

  try {
    await AI.completions(modelId, aiSdkParams, {
      ...middlewareConfig,
      assistant,
      topicId,
      callType: 'chat',
      uiMessages
    })
  } catch (error) {
    logger.error('fetchChatCompletion completions failed', error as Error)
    onChunkReceived({ type: ChunkType.ERROR, error: error as any })
    throw error
  }
}

export async function fetchModels(provider: Provider): Promise<SdkModel[]> {
  const AI = new AiProviderNew(provider)

  try {
    return await AI.models()
  } catch (error) {
    logger.error('fetchChatCompletion', error as Error)
    return []
  }
}

export function checkApiProvider(provider: Provider): void {
  if (!hasApiKey(provider)) {
    throw new Error(i18n.t('message.error.enter.api.key'))
  }

  if (!provider.apiHost && provider.type !== 'vertexai') {
    throw new Error(i18n.t('message.error.enter.api.host'))
  }

  if (isEmpty(provider.models)) {
    throw new Error(i18n.t('message.error.enter.model'))
  }
}

export async function checkApi(provider: Provider, model: Model): Promise<void> {
  checkApiProvider(provider)

  const ai = new LegacyAiProvider(provider)

  const assistant: Assistant = {
    id: 'checkApi',
    name: 'Check Api Assistant',
    prompt: '',
    topics: [],
    type: 'external',
    model: model
  }

  try {
    if (isEmbeddingModel(model)) {
      await ai.getEmbeddingDimensions(model)
    } else {
      const params: CompletionsParams = {
        callType: 'check',
        messages: 'hi',
        assistant,
        streamOutput: false,
        shouldThrow: true
      }

      const result = await ai.completions(params)

      if (!result.getText()) {
        throw new Error('No response received')
      }
    }
  } catch (error: any) {
    logger.error('Check Api Error', error)
    throw error
  }
}

export async function fetchAssistantMcpTools(assistant: Assistant) {
  let mcpTools: MCPTool[] = []

  const activedMcpServers = await mcpService.getActiveMcpServers()
  const assistantMcpServers = assistant.mcpServers || []

  const enabledMCPs = activedMcpServers.filter(server => assistantMcpServers.some(s => s.id === server.id))

  if (enabledMCPs && enabledMCPs.length > 0) {
    try {
      const toolPromises = enabledMCPs.map(async (mcpServer: MCPServer) => {
        try {
          return await mcpService.getMcpTools(mcpServer.id)
        } catch (error) {
          logger.error(`Error fetching tools from MCP server ${mcpServer.name}:`, error as Error)
          return []
        }
      })

      const results = await Promise.allSettled(toolPromises)
      mcpTools = results
        .filter((result): result is PromiseFulfilledResult<MCPTool[]> => result.status === 'fulfilled')
        .map(result => result.value)
        .flat()
    } catch (toolError) {
      logger.error('Error fetching MCP tools:', toolError as Error)
    }
  }

  return mcpTools
}
