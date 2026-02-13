import * as Localization from 'expo-localization'

import { SYSTEM_MODELS } from '@/config/models/default'
import assistantsEnJsonData from '@/resources/data/assistants-en.json'
import assistantsZhJsonData from '@/resources/data/assistants-zh.json'
import { loggerService } from '@/services/LoggerService'
import type { Assistant } from '@/types/assistant'
import { storage } from '@/utils'
const logger = loggerService.withContext('Assistant')

export function getSystemAssistants(): Assistant[] {
  let language = storage.getString('language')

  if (!language) {
    language = Localization.getLocales()[0]?.languageTag
  }

  const isEnglish = language?.includes('en')
  const fallbackModel = SYSTEM_MODELS.defaultModel[0]
  const defaultAssistantModel = SYSTEM_MODELS.defaultModel[0]

  const defaultAssistant: Assistant = {
    id: 'default',
    name: isEnglish ? 'Default Assistant' : '默认助手',
    description: isEnglish ? 'This is Default Assistant' : '这是默认助手',
    model: undefined,
    defaultModel: defaultAssistantModel,
    emoji: '😀',
    prompt: '',
    topics: [],
    type: 'system',
    settings: {
      toolUseMode: 'function'
    }
  }

  const userDefaultModel = defaultAssistant.defaultModel || fallbackModel

  const translateAssistant: Assistant = {
    id: 'translate',
    name: isEnglish ? 'Translate Assistant' : '翻译助手',
    description: isEnglish ? 'This is Translate Assistant' : '这是翻译助手',
    model: undefined,
    defaultModel: userDefaultModel,
    emoji: '🌐',
    prompt: isEnglish
      ? 'You are a translation assistant. Please translate the following text into English.'
      : '你是一个翻译助手。请将以下文本翻译成中文。',
    topics: [],
    type: 'system'
  }
  const quickAssistant: Assistant = {
    id: 'quick',
    name: isEnglish ? 'Quick Assistant' : '快速助手',
    description: isEnglish ? 'This is Quick Assistant' : '这是快速助手',
    model: undefined,
    defaultModel: userDefaultModel,
    emoji: '🏷️',
    prompt: isEnglish
      ? `You are a topic naming assistant. Your task is to generate a concise, descriptive title for a conversation.

RULES:
1. Detect the user's language from the conversation (English or Chinese)
2. Output ONLY in the user's detected language
3. For English: Maximum 10 words
4. For Chinese: Maximum 10 characters
5. Do NOT use any punctuation marks (no periods, commas, quotes, etc.)
6. Do NOT use any special symbols or emojis
7. Capture the main topic/subject of the conversation
8. Be concise but descriptive

EXAMPLES:
- "How to fix React component bug" (English)
- "Python数据分析帮助" (Chinese)
- "Git命令使用技巧" (Chinese)
- "JavaScript异步编程问题" (Chinese)

Output ONLY the title, nothing else.`
      : `你是一个话题命名助手。你的任务是为对话生成一个简洁的描述性标题。

规则：
1. 从对话中检测用户的语言（中文或英文）
2. 仅使用检测到的用户语言输出
3. 英文：最多10个单词
4. 中文：最多10个字符
5. 不使用任何标点符号（句号、逗号、引号等）
6. 不使用任何特殊符号或表情符号
7. 捕捉对话的主题/主旨
8. 简洁但有描述性

示例：
- "How to fix React component bug" (英文)
- "Python数据分析帮助" (中文)
- "Git命令使用技巧" (中文)
- "JavaScript异步编程问题" (中文)

仅输出标题，不要输出任何其他内容。`,
    topics: [],
    type: 'system'
  }

  return [defaultAssistant, translateAssistant, quickAssistant]
}

export function getBuiltInAssistants(): Assistant[] {
  let language = storage.getString('language')

  if (!language) {
    language = Localization.getLocales()[0]?.languageTag
  }

  try {
    if (assistantsEnJsonData && language?.includes('en')) {
      return JSON.parse(JSON.stringify(assistantsEnJsonData)) || []
    } else if (assistantsZhJsonData && language?.includes('zh')) {
      return JSON.parse(JSON.stringify(assistantsZhJsonData)) || []
    } else {
      return JSON.parse(JSON.stringify(assistantsZhJsonData)) || []
    }
  } catch (error) {
    logger.error('Error reading assistants data:', error)
    return []
  }
}
