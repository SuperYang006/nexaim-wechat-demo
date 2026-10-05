import type { NexaIMClient, NexaIMClientEventMap } from '../../vendor/nexaim-client';
import type { ChatStore } from '../../store/chat';
import type { SessionGate } from './lifecycle';
export type ReceivedMessage = Extract<NexaIMClientEventMap['message'], {
    type: 'message.received';
}>['payload'];
export type SendAck = Awaited<ReturnType<NexaIMClient['sendMessage']>>;
export type Draft = {
    clientMessageId: string;
    recipientUserId: string;
    messageType: 'text';
    text: string;
} | {
    clientMessageId: string;
    recipientUserId: string;
    messageType: 'image';
    mediaAssetId: string;
    caption?: string;
};
export type IMSession = {
    client: NexaIMClient;
    store: ChatStore;
    gate: SessionGate;
    tasks: Map<string, Promise<unknown>>;
};
