// ============================================================
// IM router — Feishu/Lark channel and bridge management
// ============================================================

import { guardOptionalString, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const imRouter: IpcRouter = (ctx, register) => {
	register("im:get-channels", async () => {
		return { success: true, channels: ctx.im.channelManager?.getChannels() ?? [] };
	});

	register("im:connect-feishu", async (data) => {
		guardOptionalString(data.appName, "appName");
		guardOptionalString(data.description, "description");
		if (!ctx.im.channelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		return await ctx.im.channelManager.startRegistration({
			appName: data.appName,
			description: data.description,
		});
	});

	register("im:connect-feishu-manual", async (data) => {
		const appId = guardString(data.appId, "appId");
		const appSecret = guardString(data.appSecret, "appSecret");
		guardOptionalString(data.name, "name");
		if (!ctx.im.channelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		try {
			await ctx.im.channelManager.connectManual({ appId, appSecret, name: data.name });
			return { success: true };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	register("im:cancel-registration", async (data) => {
		const registrationId = guardString(data.registrationId, "registrationId");
		ctx.im.channelManager?.cancelRegistration(registrationId);
		return { success: true };
	});

	register("im:disconnect-channel", async (data) => {
		const _provider = guardString(data.provider, "provider");
		guardOptionalString(data.appId, "appId");
		if (!ctx.im.channelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		await ctx.im.channelManager.disconnect(_provider, data.appId);
		return { success: true };
	});

	register("im:remove-channel", async (data) => {
		const _provider = guardString(data.provider, "provider");
		const _appId = guardString(data.appId, "appId");
		if (!ctx.im.channelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		await ctx.im.channelManager.removeChannel(_provider, _appId);
		return { success: true };
	});

	register("im:reconnect-channel", async (data) => {
		const _provider = guardString(data.provider, "provider");
		const _appId = guardString(data.appId, "appId");
		if (!ctx.im.channelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		try {
			await ctx.im.channelManager.reconnect(_provider, _appId);
			return { success: true };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	register("im:send-test-message", async (data) => {
		const receiveIdType = guardString(data.receiveIdType, "receiveIdType");
		const receiveId = guardString(data.receiveId, "receiveId");
		const text = guardString(data.text, "text");
		if (!ctx.im.channelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		return await ctx.im.channelManager.sendTestMessage({ receiveIdType, receiveId, text });
	});

	register("im:test-connection", async (data) => {
		const appId = guardString(data.appId, "appId");
		if (!ctx.im.channelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		return await ctx.im.channelManager.testConnection(appId);
	});

	register("im:test-connection-direct", async (data) => {
		const appId = guardString(data.appId, "appId");
		const appSecret = guardString(data.appSecret, "appSecret");
		guardOptionalString(data.name, "name");
		if (!ctx.im.channelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		return await ctx.im.channelManager.testConnectionDirect(appId, appSecret);
	});

	register("im:update-channel", async (data) => {
		const appId = guardString(data.appId, "appId");
		guardOptionalString(data.name, "name");
		if (!ctx.im.channelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		await ctx.im.channelManager.updateChannel(appId, { name: data.name });
		return { success: true };
	});

	register("im:get-bindings", async () => {
		if (!ctx.im.bridgeService) {
			return { success: false, error: "LarkBridgeService is not available" };
		}
		return { success: true, bindings: ctx.im.bridgeService.getBindings() };
	});

	register("im:remove-binding", async (data) => {
		const chatId = guardString(data.chatId, "chatId");
		if (!ctx.im.bridgeService) {
			return { success: false, error: "LarkBridgeService is not available" };
		}
		ctx.im.bridgeService.removeBinding(chatId);
		return { success: true };
	});

	register("im:get-bridge-status", async () => {
		if (!ctx.im.bridgeService) {
			return { success: false, error: "LarkBridgeService is not available" };
		}
		return { success: true, ...ctx.im.bridgeService.getStatus() };
	});
};
