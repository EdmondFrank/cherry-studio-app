/**
 * 消息转换模块
 * 将 Cherry Studio 消息格式转换为 AI SDK 消息格式
 */

import type {
  AssistantModelMessage,
  FilePart,
  ImagePart,
  ModelMessage,
  SystemModelMessage,
  TextPart,
  ToolCallPart,
  ToolContent,
  ToolModelMessage,
  ToolResultPart,
  UserModelMessage
} from 'ai'
import { File } from 'expo-file-system'

import { isImageEnhancementModel, isVisionModel } from '@/config/models'
import { loggerService } from '@/services/LoggerService'
import type { Model } from '@/types/assistant'
import type {
  FileMessageBlock,
  ImageMessageBlock,
  Message,
  ThinkingMessageBlock,
  ToolMessageBlock
} from '@/types/message'
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
 * 基于 OpenAI 格式的通用转换，支持文本、图片、文件和工具调用
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
  const toolBlocks = await findToolBlocks(message)

  if (message.role === 'user' || message.role === 'system') {
    return convertMessageToUserModelMessage(content, fileBlocks, imageBlocks, isVisionModel, model)
  } else if (message.role === 'assistant') {
    return convertMessageToAssistantModelMessage(content, fileBlocks, reasoningBlocks, toolBlocks, model)
  } else if (message.role === 'tool') {
    return convertMessageToToolModelMessage(toolBlocks)
  }

  return convertMessageToAssistantModelMessage(content, fileBlocks, reasoningBlocks, toolBlocks, model)
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
  content: string,
  fileBlocks: FileMessageBlock[],
  thinkingBlocks: ThinkingMessageBlock[],
  toolBlocks: ToolMessageBlock[],
  model?: Model
): Promise<AssistantModelMessage> {
  const parts: (TextPart | FilePart | ToolCallPart | ToolResultPart)[] = []
  if (content) {
    parts.push({ type: 'text', text: content })
  }

  for (const thinkingBlock of thinkingBlocks) {
    parts.push({ type: 'reasoning', text: thinkingBlock.content })
  }

  for (const toolBlock of toolBlocks) {
    const toolPart = convertToolBlockToToolPart(toolBlock)
    if (toolPart) {
      parts.push(toolPart)
    }
  }

  for (const fileBlock of fileBlocks) {
    if (model) {
      const filePart = await convertFileBlockToFilePart(fileBlock, model)
      if (filePart) {
        parts.push(filePart)
        continue
      }
    }

    const textPart = await convertFileBlockToTextPart(fileBlock)
    if (textPart) {
      parts.push(textPart)
    }
  }

  return {
    role: 'assistant',
    content: parts
  }
}

/**
 * 转换 ToolMessageBlock 为 AI SDK ToolCallPart 或 ToolResultPart
 * 
 * 优先级：
 * 1. 如果有 content，转换为 tool-result（工具执行结果）
 * 2. 如果没有 content 但有 arguments，转换为 tool-call（工具调用请求）
 * 3. 如果都没有，返回 null
 */
function convertToolBlockToToolPart(
  toolBlock: ToolMessageBlock
): ToolCallPart | ToolResultPart | null {
  const toolCallId = getToolCallId(toolBlock)
  const toolName = toolBlock.toolName || 'unknown_tool'

  // 优先处理 content（工具执行结果）
  if (toolBlock.content !== undefined && toolBlock.content !== null) {
    const output = typeof toolBlock.content === 'string' 
      ? toolBlock.content 
      : JSON.stringify(toolBlock.content)
    
    return {
      type: 'tool-result',
      toolCallId,
      toolName,
      output
    }
  }

  // 没有 content 但有 arguments，转换为 tool-call
  if (toolBlock.arguments && Object.keys(toolBlock.arguments).length > 0) {
    return {
      type: 'tool-call',
      toolCallId,
      toolName,
      input: toolBlock.arguments
    }
  }

  return null
}

/**
 * 转换为工具模型消息
 * 
 * role='tool' 的消息包含工具执行结果
 * 根据 AI SDK 规范，tool 消息的内容应该是工具结果的数组
 */
function convertMessageToToolModelMessage(toolBlocks: ToolMessageBlock[]): ToolModelMessage {
  const content: ToolContent = []

  for (const toolBlock of toolBlocks) {
    // role='tool' 的消息必须包含 content（工具执行结果）
    if (toolBlock.content === undefined || toolBlock.content === null) {
      logger.warn(`Tool block ${toolBlock.id} has no content, skipping in tool role message`)
      continue
    }
    
    const toolResultPart = convertToolBlockToToolResultPart(toolBlock)
    if (toolResultPart) {
      content.push(toolResultPart)
    }
  }

  return {
    role: 'tool',
    content
  }
}

/**
 * 转换 ToolMessageBlock 为 ToolResultPart
 * 用于 role='tool' 的消息转换
 */
function convertToolBlockToToolResultPart(toolBlock: ToolMessageBlock): ToolResultPart | null {
  if (toolBlock.content === undefined || toolBlock.content === null) {
    return null
  }

  const toolCallId = getToolCallId(toolBlock)
  const toolName = toolBlock.toolName || 'unknown_tool'
  const output = typeof toolBlock.content === 'string' 
    ? toolBlock.content 
    : JSON.stringify(toolBlock.content)

  return {
    type: 'tool-result',
    toolCallId,
    toolName,
    output
  }
}

/**
 * 工具调用 ID 缓存映射
 * 用于确保同一个 tool block 在多次转换时获得一致的 ID
 */
const toolCallIdCache = new Map<string, string>()

/**
 * 获取工具调用 ID
 * 优先使用 block 中的 toolId，如果没有则使用缓存或生成新的
 */
function getToolCallId(toolBlock: ToolMessageBlock): string {
  // 如果 block 已有 toolId，直接使用
  if (toolBlock.toolId) {
    return toolBlock.toolId
  }
  
  // 检查缓存
  if (toolCallIdCache.has(toolBlock.id)) {
    return toolCallIdCache.get(toolBlock.id)!
  }
  
  // 生成新的 ID 并缓存
  const newId = generateToolCallId()
  toolCallIdCache.set(toolBlock.id, newId)
  return newId
}

/**
 * 生成工具调用 ID
 */
function generateToolCallId(): string {
  return `tool_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
}

/**
 * 清除工具调用 ID 缓存
 * 在消息转换完成后调用，避免内存泄漏
 */
export function clearToolCallIdCache(): void {
  toolCallIdCache.clear()
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
  try {
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
  } finally {
    clearToolCallIdCache()
  }
}
