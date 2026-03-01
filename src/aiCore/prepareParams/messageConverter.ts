/**
 * 消息转换模块
 * 将 Cherry Studio 消息格式转换为 AI SDK 消息格式
 */

import { safeParseJSON } from '@ai-sdk/provider-utils'
import type {
  AssistantModelMessage,
  FilePart,
  ImagePart,
  ModelMessage,
  SystemModelMessage,
  TextPart,
  UserModelMessage
} from 'ai'
import { File } from 'expo-file-system'

import { isImageEnhancementModel, isVisionModel } from '@/config/models'
import { loggerService } from '@/services/LoggerService'
import type { Model } from '@/types/assistant'
import type { FileMessageBlock, ImageMessageBlock, Message, ThinkingMessageBlock } from '@/types/message'
import {
  findFileBlocks,
  findImageBlocks,
  findThinkingBlocks,
  findToolBlocks,
  getMainTextContent
} from '@/utils/messageUtils/find'

import { convertFileBlockToFilePart, convertFileBlockToTextPart } from './fileProcessor'

const logger = loggerService.withContext('messageConverter')

/**
 * 转换消息为 AI SDK 参数格式
 * 基于 OpenAI 格式的通用转换，支持文本、图片和文件
 */
export async function convertMessageToSdkParam(
  message: Message,
  isVisionModel = false,
  model?: Model
): Promise<ModelMessage | ModelMessage[]> {
  const content = await getMainTextContent(message)
  const fileBlocks = await findFileBlocks(message)
  const imageBlocks = await findImageBlocks(message)
  const reasoningBlocks = await findThinkingBlocks(message)

  if (message.role === 'user' || message.role === 'system') {
    return convertMessageToUserModelMessage(content, fileBlocks, imageBlocks, isVisionModel, model)
  } else {
    return convertMessageToAssistantModelMessage(message, content, fileBlocks, reasoningBlocks, model)
  }
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') return value

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

async function buildToolHistoryMessages(toolBlocks: any[]): Promise<ModelMessage[]> {
  const toolResponses = toolBlocks.map((block) => (block as any)?.metadata?.rawMcpToolResponse).filter(Boolean)

  // Only replay client-side tools (function_call/function_call_output).
  // Provider-executed tools (e.g. web_search) have special replay semantics and are handled by the provider.
  const replayable = toolResponses.filter((tr: any) => tr?.tool?.type !== 'provider')

  if (replayable.length === 0) return []

  const parseToolCallInput = async (value: unknown): Promise<unknown> => {
    if (typeof value !== 'string') return value

    const parsed = await safeParseJSON({ text: value })
    return parsed.success ? parsed.value : value
  }

  const toolCallParts = await Promise.all(
    replayable.map(async (tr: any) => ({
      type: 'tool-call' as const,
      toolCallId: tr.toolCallId ?? tr.id,
      toolName: tr.tool?.name ?? tr.toolName,
      input: await parseToolCallInput(tr.arguments)
    }))
  )

  const toolResultParts = replayable
    .filter((tr: any) => tr.status === 'done' || tr.status === 'error' || tr.status === 'cancelled')
    .map((tr: any) => ({
      type: 'tool-result' as const,
      toolCallId: tr.toolCallId ?? tr.id,
      toolName: tr.tool?.name ?? tr.toolName,
      output: {
        type: tr.status === 'error' || tr.status === 'cancelled' ? ('error-text' as const) : ('text' as const),
        value:
          tr.status === 'cancelled' && (tr.response === undefined || tr.response === null)
            ? 'cancelled'
            : stringifyToolOutput(tr.response)
      }
    }))

  const messages: ModelMessage[] = []

  if (toolCallParts.length > 0) {
    messages.push({
      role: 'assistant',
      content: toolCallParts
    })
  }

  if (toolResultParts.length > 0) {
    messages.push({
      role: 'tool',
      content: toolResultParts
    })
  }

  return messages
}

async function convertImageBlockToImagePart(imageBlocks: ImageMessageBlock[]): Promise<ImagePart[]> {
  const parts: ImagePart[] = []
  for (const imageBlock of imageBlocks) {
    if (imageBlock.file) {
      try {
        const image = new File(imageBlock.file.path)
        parts.push({
          type: 'image',
          image: await image.base64(),
          mediaType: image.type
        })
      } catch (error) {
        logger.warn('Failed to load image:', error as Error)
      }
    } else if (imageBlock.url) {
      const isBase64 = imageBlock.url.startsWith('data:')
      if (isBase64) {
        const base64 = imageBlock.url.match(/^data:[^;]*;base64,(.+)$/)![1]
        const mimeMatch = imageBlock.url.match(/^data:([^;]+)/)
        parts.push({
          type: 'image',
          image: base64,
          mediaType: mimeMatch ? mimeMatch[1] : 'image/png'
        })
      } else {
        parts.push({
          type: 'image',
          image: imageBlock.url
        })
      }
    }
  }
  return parts
}

/**
 * 转换为用户模型消息
 */
async function convertMessageToUserModelMessage(
  content: string,
  fileBlocks: FileMessageBlock[],
  imageBlocks: ImageMessageBlock[],
  isVisionModel = false,
  model?: Model
): Promise<UserModelMessage | (UserModelMessage | SystemModelMessage)[]> {
  const parts: (TextPart | FilePart | ImagePart)[] = []
  if (content) {
    parts.push({ type: 'text', text: content })
  }

  // 处理图片（仅在支持视觉的模型中）
  if (isVisionModel) {
    parts.push(...(await convertImageBlockToImagePart(imageBlocks)))
  }
  // 处理文件
  for (const fileBlock of fileBlocks) {
    const file = fileBlock.file
    let processed = false

    // 优先尝试原生文件支持（PDF、图片等）
    if (model) {
      const filePart = await convertFileBlockToFilePart(fileBlock, model)
      if (filePart) {
        // 判断filePart是否为string
        if (typeof filePart.data === 'string' && filePart.data.startsWith('fileid://')) {
          return [
            {
              role: 'system',
              content: filePart.data
            },
            {
              role: 'user',
              content: parts.length > 0 ? parts : ''
            }
          ]
        }
        parts.push(filePart)
        logger.debug(`File ${file.origin_name} processed as native file format`)
        processed = true
      }
    }

    // 如果原生处理失败，回退到文本提取
    if (!processed) {
      const textPart = await convertFileBlockToTextPart(fileBlock)
      if (textPart) {
        parts.push(textPart)
        logger.debug(`File ${file.origin_name} processed as text content`)
      } else {
        logger.warn(`File ${file.origin_name} could not be processed in any format`)
      }
    }
  }

  return {
    role: 'user',
    content: parts
  }
}
/**
 * 转换为助手模型消息
 */
async function convertMessageToAssistantModelMessage(
  message: Message,
  content: string,
  fileBlocks: FileMessageBlock[],
  thinkingBlocks: ThinkingMessageBlock[],
  model?: Model
): Promise<ModelMessage | ModelMessage[]> {
  const toolBlocks = await findToolBlocks(message)
  const toolHistoryMessages = await buildToolHistoryMessages(toolBlocks)

  const parts: Array<TextPart | FilePart> = []

  if (content) {
    parts.push({ type: 'text', text: content })
  }

  for (const thinkingBlock of thinkingBlocks) {
    parts.push({ type: 'reasoning', text: thinkingBlock.content })
  }

  for (const fileBlock of fileBlocks) {
    // 优先尝试原生文件支持（PDF等）
    if (model) {
      const filePart = await convertFileBlockToFilePart(fileBlock, model)
      if (filePart) {
        parts.push(filePart)
        continue
      }
    }

    // 回退到文本处理
    const textPart = await convertFileBlockToTextPart(fileBlock)
    if (textPart) {
      parts.push(textPart)
    }
  }

  const assistantMessage: AssistantModelMessage = {
    role: 'assistant',
    content: parts
  }

  const hasAssistantContent =
    typeof assistantMessage.content === 'string'
      ? assistantMessage.content.trim().length > 0
      : Array.isArray(assistantMessage.content) && assistantMessage.content.length > 0

  if (toolHistoryMessages.length === 0) {
    return assistantMessage
  }

  return hasAssistantContent ? [...toolHistoryMessages, assistantMessage] : toolHistoryMessages
}
/**
 * Converts an array of messages to SDK-compatible model messages.
 *
 * This function processes messages and transforms them into the format required by the SDK.
 * It handles special cases for vision models and image enhancement models.
 *
 * @param messages - Array of messages to convert. Must contain at least 2 messages when using image enhancement models.
 * @param model - The model configuration that determines conversion behavior
 *
 * @returns A promise that resolves to an array of SDK-compatible model messages
 *
 * @remarks
 * For image enhancement models with 2+ messages:
 * - Expects the second-to-last message (index length-2) to be an assistant message containing image blocks
 * - Expects the last message (index length-1) to be a user message
 * - Extracts images from the assistant message and appends them to the user message content
 * - Returns only the last two processed messages [assistantSdkMessage, userSdkMessage]
 *
 * For other models:
 * - Returns all converted messages in order
 *
 * The function automatically detects vision model capabilities and adjusts conversion accordingly.
 */
export async function convertMessagesToSdkMessages(messages: Message[], model: Model): Promise<ModelMessage[]> {
  const sdkMessages: ModelMessage[] = []
  const isVision = isVisionModel(model)

  for (const message of messages) {
    const sdkMessage = await convertMessageToSdkParam(message, isVision, model)
    sdkMessages.push(...(Array.isArray(sdkMessage) ? sdkMessage : [sdkMessage]))
  }
  // Special handling for image enhancement models
  // Only keep the last two messages and merge images into the user message
  // [system?, user, assistant, user]
  if (isImageEnhancementModel(model) && messages.length >= 3) {
    const needUpdatedMessages = messages.slice(-2)
    const needUpdatedSdkMessages = sdkMessages.slice(-2)
    const assistantMessage = needUpdatedMessages.filter(m => m.role === 'assistant')[0]
    const assistantSdkMessage = needUpdatedSdkMessages.filter(m => m.role === 'assistant')[0]
    const userSdkMessage = needUpdatedSdkMessages.filter(m => m.role === 'user')[0]
    const systemSdkMessages = sdkMessages.filter(m => m.role === 'system')
    const imageBlocks = await findImageBlocks(assistantMessage)
    const imageParts = await convertImageBlockToImagePart(imageBlocks)
    const parts: (TextPart | ImagePart | FilePart)[] = []
    if (typeof userSdkMessage.content === 'string') {
      parts.push({ type: 'text', text: userSdkMessage.content })
      parts.push(...imageParts)
      userSdkMessage.content = parts
    } else {
      userSdkMessage.content.push(...imageParts)
    }
    if (systemSdkMessages.length > 0) {
      return [systemSdkMessages[0], assistantSdkMessage, userSdkMessage]
    }
    return [assistantSdkMessage, userSdkMessage]
  }

  return sdkMessages
}
