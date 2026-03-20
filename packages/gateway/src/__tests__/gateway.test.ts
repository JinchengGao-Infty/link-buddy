import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Gateway, type GatewayDeps } from '../gateway.js';
import type { IncomingMessage, PlatformAdapter, AgentEvent, AgentRequest } from '@ccbuddy/core';

// ── Test Helpers ──────────────────────────────────────────────────────────────

function createMockDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  return {
    eventBus: {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
    findUser: vi.fn().mockReturnValue({
      name: 'Dad',
      role: 'admin' as const,
      platformIds: { discord: '123' },
    }),
    buildSessionId: vi.fn().mockReturnValue('dad-discord-ch1'),
    executeAgentRequest: vi.fn().mockImplementation(async function* () {
      yield {
        type: 'complete' as const,
        response: 'Hello!',
        sessionId: 'dad-discord-ch1',
        userId: 'Dad',
        channelId: 'ch1',
        platform: 'discord',
      } satisfies AgentEvent;
    }),
    assembleContext: vi.fn().mockReturnValue('memory context'),
    storeMessage: vi.fn(),
    gatewayConfig: { unknown_user_reply: true },
    platformsConfig: {},
    ...overrides,
  };
}

function createMockAdapter(platform = 'discord') {
  let messageHandler: ((msg: IncomingMessage) => void) | undefined;

  const adapter: PlatformAdapter & {
    simulateMessage: (msg: IncomingMessage) => Promise<void>;
  } = {
    platform,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn().mockImplementation((handler: (msg: IncomingMessage) => void) => {
      messageHandler = handler;
    }),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    setTypingIndicator: vi.fn().mockResolvedValue(undefined),
    simulateMessage: async (msg: IncomingMessage) => {
      if (messageHandler) {
        await (messageHandler(msg) as unknown as Promise<void>);
      }
    },
  };
  return adapter;
}

function makeIncomingMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'discord',
    platformUserId: '123',
    channelId: 'ch1',
    channelType: 'dm',
    text: 'Hello CCBuddy',
    attachments: [],
    isMention: false,
    raw: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Gateway', () => {
  let deps: GatewayDeps;
  let gateway: Gateway;
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    deps = createMockDeps();
    gateway = new Gateway(deps);
    adapter = createMockAdapter();
  });

  describe('registerAdapter', () => {
    it('stores adapter and wires onMessage handler', () => {
      gateway.registerAdapter(adapter);
      expect(adapter.onMessage).toHaveBeenCalledOnce();
      expect(gateway.getAdapter('discord')).toBe(adapter);
    });

    it('supports multiple adapters', () => {
      const telegram = createMockAdapter('telegram');
      gateway.registerAdapter(adapter);
      gateway.registerAdapter(telegram);
      expect(gateway.getAdapter('discord')).toBe(adapter);
      expect(gateway.getAdapter('telegram')).toBe(telegram);
    });
  });

  describe('start / stop', () => {
    it('starts all registered adapters', async () => {
      gateway.registerAdapter(adapter);
      await gateway.start();
      expect(adapter.start).toHaveBeenCalledOnce();
    });

    it('stops all registered adapters', async () => {
      gateway.registerAdapter(adapter);
      await gateway.start();
      await gateway.stop();
      expect(adapter.stop).toHaveBeenCalledOnce();
    });
  });

  describe('incoming message handling', () => {
    beforeEach(() => {
      gateway.registerAdapter(adapter);
    });

    it('identifies known users and routes to agent', async () => {
      await adapter.simulateMessage(makeIncomingMsg());
      expect(deps.findUser).toHaveBeenCalledWith('discord', '123');
      expect(deps.buildSessionId).toHaveBeenCalledWith('Dad', 'discord', 'ch1');
      expect(deps.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'Dad', role: 'user', content: 'Hello CCBuddy' }),
      );
      expect(deps.assembleContext).toHaveBeenCalledWith('Dad', 'dad-discord-ch1');
      expect(deps.executeAgentRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Hello CCBuddy',
          userId: 'Dad',
          sessionId: 'dad-discord-ch1',
          platform: 'discord',
          permissionLevel: 'admin',
          memoryContext: 'memory context',
        }),
      );
    });

    it('sends unknown user reply when enabled', async () => {
      (deps.findUser as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      await adapter.simulateMessage(makeIncomingMsg());
      expect(adapter.sendText).toHaveBeenCalledWith(
        'ch1',
        "I don't recognize you. Ask the admin to add you.",
      );
      expect(deps.executeAgentRequest).not.toHaveBeenCalled();
    });

    it('silently ignores unknown users when reply disabled', async () => {
      deps = createMockDeps({
        findUser: vi.fn().mockReturnValue(undefined),
        gatewayConfig: { unknown_user_reply: false },
      });
      gateway = new Gateway(deps);
      const newAdapter = createMockAdapter();
      gateway.registerAdapter(newAdapter);
      await newAdapter.simulateMessage(makeIncomingMsg());
      expect(newAdapter.sendText).not.toHaveBeenCalled();
    });

    it('checks activation mode and skips non-activated channels', async () => {
      deps = createMockDeps({
        platformsConfig: { discord: { channels: { ch1: { mode: 'mention' } } } },
      });
      gateway = new Gateway(deps);
      const newAdapter = createMockAdapter();
      gateway.registerAdapter(newAdapter);
      await newAdapter.simulateMessage(makeIncomingMsg({ channelType: 'group', isMention: false }));
      expect(deps.executeAgentRequest).not.toHaveBeenCalled();
    });

    it('publishes message.incoming event', async () => {
      await adapter.simulateMessage(makeIncomingMsg());
      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'message.incoming',
        expect.objectContaining({
          userId: 'Dad',
          sessionId: 'dad-discord-ch1',
          platform: 'discord',
          text: 'Hello CCBuddy',
        }),
      );
    });

    it('maps chat role to chat permission level', async () => {
      (deps.findUser as ReturnType<typeof vi.fn>).mockReturnValue({
        name: 'Son',
        role: 'chat',
        platformIds: { discord: '456' },
      });
      await adapter.simulateMessage(makeIncomingMsg());
      expect(deps.executeAgentRequest).toHaveBeenCalledWith(
        expect.objectContaining({ permissionLevel: 'chat' }),
      );
    });
  });

  describe('session.conflict event handling', () => {
    it('sends queued notification to the correct channel when conflict event fires', async () => {
      gateway.registerAdapter(adapter);

      // Retrieve the handler registered via subscribe
      const subscribeCalls = (deps.eventBus.subscribe as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const subscribeCall = subscribeCalls.find((call) => call[0] === 'session.conflict');
      expect(subscribeCall).toBeDefined();
      const conflictHandler = subscribeCall![1] as (payload: unknown) => void;

      conflictHandler({
        userId: 'user-1',
        sessionId: 'session-1',
        channelId: 'dev',
        platform: 'discord',
        workingDirectory: '/project',
        conflictingPid: 0,
      });

      // Allow any microtasks/promises to settle
      await Promise.resolve();

      expect(adapter.sendText).toHaveBeenCalledWith(
        'dev',
        expect.stringContaining('queued'),
      );
    });

    it('does nothing when conflict event fires for an unknown platform', async () => {
      // adapter is discord; conflict event comes in for telegram
      gateway.registerAdapter(adapter);

      const subscribeCalls2 = (deps.eventBus.subscribe as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const subscribeCall = subscribeCalls2.find((call) => call[0] === 'session.conflict');
      const conflictHandler = subscribeCall![1] as (payload: unknown) => void;

      conflictHandler({
        userId: 'user-1',
        sessionId: 'session-1',
        channelId: 'dev',
        platform: 'telegram',
        workingDirectory: '/project',
        conflictingPid: 0,
      });

      await Promise.resolve();

      expect(adapter.sendText).not.toHaveBeenCalled();
    });
  });

  describe('agent execution and response routing', () => {
    beforeEach(() => {
      gateway.registerAdapter(adapter);
    });

    it('sends agent response to platform and stores it', async () => {
      await adapter.simulateMessage(makeIncomingMsg());
      expect(adapter.sendText).toHaveBeenCalledWith('ch1', 'Hello!');
      expect(deps.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'Dad', role: 'assistant', content: 'Hello!' }),
      );
    });

    it('publishes message.outgoing event on complete', async () => {
      await adapter.simulateMessage(makeIncomingMsg());
      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'message.outgoing',
        expect.objectContaining({
          userId: 'Dad',
          platform: 'discord',
          text: 'Hello!',
        }),
      );
    });

    it('starts and stops typing indicator', async () => {
      await adapter.simulateMessage(makeIncomingMsg());
      expect(adapter.setTypingIndicator).toHaveBeenCalledWith('ch1', true);
      expect(adapter.setTypingIndicator).toHaveBeenCalledWith('ch1', false);
    });

    it('sends error message on agent error event', async () => {
      deps = createMockDeps({
        executeAgentRequest: vi.fn().mockImplementation(async function* () {
          yield {
            type: 'error' as const,
            error: 'Rate limit exceeded',
            sessionId: 's1',
            userId: 'Dad',
            channelId: 'ch1',
            platform: 'discord',
          } satisfies AgentEvent;
        }),
      });
      gateway = new Gateway(deps);
      const newAdapter = createMockAdapter();
      gateway.registerAdapter(newAdapter);
      await newAdapter.simulateMessage(makeIncomingMsg());
      expect(newAdapter.sendText).toHaveBeenCalledWith(
        'ch1',
        'Sorry, something went wrong: Rate limit exceeded',
      );
    });

    it('sends generic error on generator throw', async () => {
      deps = createMockDeps({
        executeAgentRequest: vi.fn().mockImplementation(async function* () {
          throw new Error('Connection lost');
        }),
      });
      gateway = new Gateway(deps);
      const newAdapter = createMockAdapter();
      gateway.registerAdapter(newAdapter);
      await newAdapter.simulateMessage(makeIncomingMsg());
      expect(newAdapter.sendText).toHaveBeenCalledWith(
        'ch1',
        'Sorry, something went wrong processing your message.',
      );
    });

    it('chunks long responses for discord', async () => {
      const longResponse = 'a'.repeat(3000);
      deps = createMockDeps({
        executeAgentRequest: vi.fn().mockImplementation(async function* () {
          yield {
            type: 'complete' as const,
            response: longResponse,
            sessionId: 's1',
            userId: 'Dad',
            channelId: 'ch1',
            platform: 'discord',
          } satisfies AgentEvent;
        }),
      });
      gateway = new Gateway(deps);
      const newAdapter = createMockAdapter();
      gateway.registerAdapter(newAdapter);
      await newAdapter.simulateMessage(makeIncomingMsg());
      expect(newAdapter.sendText).toHaveBeenCalledTimes(2);
    });

    it('uses telegram char limit for telegram platform', async () => {
      const longResponse = 'b'.repeat(5000);
      deps = createMockDeps({
        executeAgentRequest: vi.fn().mockImplementation(async function* () {
          yield {
            type: 'complete' as const,
            response: longResponse,
            sessionId: 's1',
            userId: 'Dad',
            channelId: 'ch1',
            platform: 'telegram',
          } satisfies AgentEvent;
        }),
      });
      gateway = new Gateway(deps);
      const tgAdapter = createMockAdapter('telegram');
      gateway.registerAdapter(tgAdapter);
      await tgAdapter.simulateMessage(makeIncomingMsg({ platform: 'telegram' }));
      expect(tgAdapter.sendText).toHaveBeenCalledTimes(2);
    });
  });
});
