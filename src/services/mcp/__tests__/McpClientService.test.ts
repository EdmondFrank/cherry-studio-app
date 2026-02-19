import { RNStreamableHTTPClientTransport } from '@cherrystudio/react-native-streamable-http'
import { Client } from '@modelcontextprotocol/sdk/client'

import type { MCPServer } from '@/types/mcp'

import { McpClientService } from '../McpClientService'

// Mock the dependencies
jest.mock('@cherrystudio/react-native-streamable-http')
jest.mock('@modelcontextprotocol/sdk/client')
jest.mock('../oauth', () => ({
  createMobileOAuthProvider: jest.fn(() => ({})),
  performOAuthFlow: jest.fn()
}))
jest.mock('@/services/LoggerService', () => ({
  loggerService: {
    withContext: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      verbose: jest.fn()
    })
  }
}))
jest.mock('@/i18n', () => ({
  __esModule: true,
  default: {
    t: (key: string, params?: Record<string, string>) => key
  }
}))
jest.mock('@/componentsV2/base/Dialog/useDialogManager', () => ({
  presentDialog: jest.fn(),
  dismissDialog: jest.fn()
}))

describe('McpClientService', () => {
  let service: McpClientService
  let mockTransport: jest.Mocked<RNStreamableHTTPClientTransport>
  let mockClient: jest.Mocked<Client>

  const createMockServer = (overrides?: Partial<MCPServer>): MCPServer => ({
    id: 'test-server',
    name: 'Test Server',
    type: 'streamableHttp',
    baseUrl: 'https://example.com/mcp',
    isActive: true,
    ...overrides
  })

  beforeEach(() => {
    jest.clearAllMocks()

    // Reset singleton instance
    // @ts-expect-error - accessing private static property for testing
    McpClientService.instance = undefined

    mockTransport = {
      onmessage: undefined,
      onerror: undefined,
      onclose: undefined,
      close: jest.fn().mockResolvedValue(undefined)
    } as unknown as jest.Mocked<RNStreamableHTTPClientTransport>

    mockClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      listTools: jest.fn().mockResolvedValue({ tools: [] }),
      callTool: jest.fn().mockResolvedValue({ content: [] })
    } as unknown as jest.Mocked<Client>

    ;(RNStreamableHTTPClientTransport as jest.Mock).mockImplementation(() => mockTransport)
    ;(Client as jest.Mock).mockImplementation(() => mockClient)

    service = McpClientService.getInstance()
  })

  describe('timeout configuration', () => {
    it('should use default timeout of 300 seconds when not specified', async () => {
      const server = createMockServer()
      await service.getClient(server)

      expect(RNStreamableHTTPClientTransport).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          timeout: 300 * 1000 // 300 seconds in milliseconds
        })
      )
    })

    it('should use custom timeout from server config', async () => {
      const server = createMockServer({ timeout: 600 })
      await service.getClient(server)

      expect(RNStreamableHTTPClientTransport).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          timeout: 600 * 1000 // 600 seconds in milliseconds
        })
      )
    })

    it('should enforce minimum timeout of 5 seconds', async () => {
      const server = createMockServer({ timeout: 1 })
      await service.getClient(server)

      expect(RNStreamableHTTPClientTransport).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          timeout: 5 * 1000 // minimum 5 seconds
        })
      )
    })

    it('should enforce maximum timeout of 3600 seconds', async () => {
      const server = createMockServer({ timeout: 5000 })
      await service.getClient(server)

      expect(RNStreamableHTTPClientTransport).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          timeout: 3600 * 1000 // maximum 3600 seconds
        })
      )
    })

    it('should handle timeout of exactly 5 seconds (boundary)', async () => {
      const server = createMockServer({ timeout: 5 })
      await service.getClient(server)

      expect(RNStreamableHTTPClientTransport).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          timeout: 5 * 1000
        })
      )
    })

    it('should handle timeout of exactly 3600 seconds (boundary)', async () => {
      const server = createMockServer({ timeout: 3600 })
      await service.getClient(server)

      expect(RNStreamableHTTPClientTransport).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          timeout: 3600 * 1000
        })
      )
    })

    it('should pass timeout along with other options', async () => {
      const server = createMockServer({
        timeout: 120,
        headers: { 'X-Custom': 'value' }
      })
      await service.getClient(server)

      expect(RNStreamableHTTPClientTransport).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          timeout: 120 * 1000,
          requestInit: expect.objectContaining({
            headers: { 'X-Custom': 'value' }
          }),
          authProvider: expect.any(Object)
        })
      )
    })
  })

  describe('client caching', () => {
    it('should reuse existing client with same server config', async () => {
      const server = createMockServer({ timeout: 300 })

      const client1 = await service.getClient(server)
      const client2 = await service.getClient(server)

      expect(client1).toBe(client2)
      expect(RNStreamableHTTPClientTransport).toHaveBeenCalledTimes(1)
    })

    it('should create new client when timeout changes', async () => {
      const server1 = createMockServer({ timeout: 300 })
      const server2 = createMockServer({ timeout: 600 })

      await service.getClient(server1)
      await service.getClient(server2)

      expect(RNStreamableHTTPClientTransport).toHaveBeenCalledTimes(2)
    })
  })
})
