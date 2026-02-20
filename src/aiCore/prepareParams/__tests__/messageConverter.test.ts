import type { ToolMessageBlock } from '@/types/message'
import { MessageBlockStatus, MessageBlockType } from '@/types/message'

// Mock dependencies
jest.mock('@/utils/messageUtils/find', () => ({
  findFileBlocks: jest.fn().mockResolvedValue([]),
  findImageBlocks: jest.fn().mockResolvedValue([]),
  findThinkingBlocks: jest.fn().mockResolvedValue([]),
  findToolBlocks: jest.fn().mockResolvedValue([]),
  getMainTextContent: jest.fn().mockResolvedValue('')
}))

jest.mock('@/services/LoggerService', () => ({
  loggerService: {
    withContext: jest.fn().mockReturnValue({
      debug: jest.fn(),
      warn: jest.fn()
    })
  }
}))

jest.mock('./fileProcessor', () => ({
  convertFileBlockToFilePart: jest.fn().mockResolvedValue(null),
  convertFileBlockToTextPart: jest.fn().mockResolvedValue(null)
}))

describe('messageConverter', () => {
  describe('Tool Calling Conversion', () => {
    const createMockToolBlock = (overrides: Partial<ToolMessageBlock> = {}): ToolMessageBlock => ({
      id: 'tool-1',
      messageId: 'msg-1',
      type: MessageBlockType.TOOL,
      createdAt: Date.now(),
      status: MessageBlockStatus.SUCCESS,
      toolId: 'call_123',
      toolName: 'test_tool',
      arguments: { key: 'value' },
      content: 'Tool execution result',
      ...overrides
    })

    describe('Tool ID Consistency', () => {
      it('should use toolId from block when available', async () => {
        const { convertMessageToSdkParam } = await import('../messageConverter')
        const { findToolBlocks } = await import('@/utils/messageUtils/find')

        const toolBlock = createMockToolBlock({
          toolId: 'call_abc123',
          toolName: 'my_tool',
          content: 'result'
        })

        ;(findToolBlocks as jest.Mock).mockResolvedValue([toolBlock])

        const message = {
          id: 'msg-1',
          role: 'assistant' as const,
          assistantId: 'assistant-1',
          topicId: 'topic-1',
          createdAt: Date.now(),
          status: 'success' as const,
          blocks: ['tool-1']
        }

        const result = await convertMessageToSdkParam(message)

        expect(result).toMatchObject({
          role: 'assistant',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'tool-result',
              toolCallId: 'call_abc123',
              toolName: 'my_tool'
            })
          ])
        })
      })

      it('should generate consistent toolCallId when toolId is missing', async () => {
        const { convertMessageToSdkParam } = await import('../messageConverter')
        const { findToolBlocks } = await import('@/utils/messageUtils/find')

        const toolBlock = createMockToolBlock({
          toolId: undefined,
          content: 'result'
        })

        ;(findToolBlocks as jest.Mock).mockResolvedValue([toolBlock])

        const message = {
          id: 'msg-1',
          role: 'assistant' as const,
          assistantId: 'assistant-1',
          topicId: 'topic-1',
          createdAt: Date.now(),
          status: 'success' as const,
          blocks: ['tool-1']
        }

        const result = await convertMessageToSdkParam(message)

        const toolResult = (result as any).content.find((c: any) => c.type === 'tool-result')
        expect(toolResult.toolCallId).toMatch(/^tool_\d+_[a-z0-9]+$/)
      })
    })

    describe('Tool Content Conversion', () => {
      it('should convert string content to tool-result', async () => {
        const { convertMessageToSdkParam } = await import('../messageConverter')
        const { findToolBlocks } = await import('@/utils/messageUtils/find')

        const toolBlock = createMockToolBlock({
          content: 'String result',
          arguments: undefined
        })

        ;(findToolBlocks as jest.Mock).mockResolvedValue([toolBlock])

        const message = {
          id: 'msg-1',
          role: 'assistant' as const,
          assistantId: 'assistant-1',
          topicId: 'topic-1',
          createdAt: Date.now(),
          status: 'success' as const,
          blocks: ['tool-1']
        }

        const result = await convertMessageToSdkParam(message)

        expect(result).toMatchObject({
          role: 'assistant',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'tool-result',
              output: 'String result'
            })
          ])
        })
      })

      it('should convert object content to JSON string in tool-result', async () => {
        const { convertMessageToSdkParam } = await import('../messageConverter')
        const { findToolBlocks } = await import('@/utils/messageUtils/find')

        const toolBlock = createMockToolBlock({
          content: { data: 'value', number: 42 },
          arguments: undefined
        })

        ;(findToolBlocks as jest.Mock).mockResolvedValue([toolBlock])

        const message = {
          id: 'msg-1',
          role: 'assistant' as const,
          assistantId: 'assistant-1',
          topicId: 'topic-1',
          createdAt: Date.now(),
          status: 'success' as const,
          blocks: ['tool-1']
        }

        const result = await convertMessageToSdkParam(message)

        const toolResult = (result as any).content.find((c: any) => c.type === 'tool-result')
        expect(toolResult.output).toBe('{"data":"value","number":42}')
      })
    })

    describe('Tool Arguments Conversion', () => {
      it('should convert arguments to tool-call when no content', async () => {
        const { convertMessageToSdkParam } = await import('../messageConverter')
        const { findToolBlocks } = await import('@/utils/messageUtils/find')

        const toolBlock = createMockToolBlock({
          content: undefined,
          arguments: { query: 'search term' }
        })

        ;(findToolBlocks as jest.Mock).mockResolvedValue([toolBlock])

        const message = {
          id: 'msg-1',
          role: 'assistant' as const,
          assistantId: 'assistant-1',
          topicId: 'topic-1',
          createdAt: Date.now(),
          status: 'success' as const,
          blocks: ['tool-1']
        }

        const result = await convertMessageToSdkParam(message)

        expect(result).toMatchObject({
          role: 'assistant',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'tool-call',
              input: { query: 'search term' }
            })
          ])
        })
      })
    })

    describe('Edge Cases', () => {
      it('should handle tool block with both arguments and content', async () => {
        const { convertMessageToSdkParam } = await import('../messageConverter')
        const { findToolBlocks } = await import('@/utils/messageUtils/find')

        const toolBlock = createMockToolBlock({
          arguments: { query: 'test' },
          content: 'result'
        })

        ;(findToolBlocks as jest.Mock).mockResolvedValue([toolBlock])

        const message = {
          id: 'msg-1',
          role: 'assistant' as const,
          assistantId: 'assistant-1',
          topicId: 'topic-1',
          createdAt: Date.now(),
          status: 'success' as const,
          blocks: ['tool-1']
        }

        const result = await convertMessageToSdkParam(message)

        // When both arguments and content exist, should prefer tool-result
        const toolResult = (result as any).content.find((c: any) => c.type === 'tool-result')
        expect(toolResult).toBeDefined()
        expect(toolResult.output).toBe('result')
      })

      it('should handle empty tool blocks array', async () => {
        const { convertMessageToSdkParam } = await import('../messageConverter')
        const { findToolBlocks } = await import('@/utils/messageUtils/find')

        ;(findToolBlocks as jest.Mock).mockResolvedValue([])

        const message = {
          id: 'msg-1',
          role: 'assistant' as const,
          assistantId: 'assistant-1',
          topicId: 'topic-1',
          createdAt: Date.now(),
          status: 'success' as const,
          blocks: []
        }

        const result = await convertMessageToSdkParam(message)

        expect(result).toMatchObject({
          role: 'assistant',
          content: expect.any(Array)
        })
      })

      it('should skip tool blocks without content and arguments', async () => {
        const { convertMessageToSdkParam } = await import('../messageConverter')
        const { findToolBlocks } = await import('@/utils/messageUtils/find')

        const toolBlock = createMockToolBlock({
          content: undefined,
          arguments: undefined
        })

        ;(findToolBlocks as jest.Mock).mockResolvedValue([toolBlock])

        const message = {
          id: 'msg-1',
          role: 'assistant' as const,
          assistantId: 'assistant-1',
          topicId: 'topic-1',
          createdAt: Date.now(),
          status: 'success' as const,
          blocks: ['tool-1']
        }

        const result = await convertMessageToSdkParam(message)

        const toolParts = (result as any).content.filter(
          (c: any) => c.type === 'tool-call' || c.type === 'tool-result'
        )
        expect(toolParts).toHaveLength(0)
      })
    })
  })
})