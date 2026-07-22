// ============================================================
// IM router — Feishu/Lark channel and bridge management
// ============================================================

import { guardOptionalString, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const imRouter: IpcRouter = (ctx, register) => {
	register("im:get-channels", async () => {
		return { success: true, channels: ctx.larkChannelManager?.getChannels() ?? [] };
	});

	register("im:connect-feishu", async (data) => {
		guardOptionalString(data.appName, "appName");
		guardOptionalString(data.description, "description");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		return await ctx.larkChannelManager.startRegistration({
			appName: data.appName,
			description: data.description,
		});
	});

	register("im:connect-feishu-manual", async (data) => {
		const appId = guardString(data.appId, "appId");
		const appSecret = guardString(data.appSecret, "appSecret");
		guardOptionalString(data.name, "name");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		try {
			await ctx.larkChannelManager.connectManual({ appId, appSecret, name: data.name });
			return { success: true };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	register("im:cancel-registration", async (data) => {
		const registrationId = guardString(data.registrationId, "registrationId");
		ctx.larkChannelManager?.cancelRegistration(registrationId);
		return { success: true };
	});

	register("im:disconnect-channel", async (data) => {
		const _provider = guardString(data.provider, "provider");
		guardOptionalString(data.appId, "appId");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		await ctx.larkChannelManager.disconnect(_provider, data.appId);
		return { success: true };
	});

	register("im:remove-channel", async (data) => {
		const _provider = guardString(data.provider, "provider");
		const _appId = guardString(data.appId, "appId");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		await ctx.larkChannelManager.removeChannel(_provider, _appId);
		return { success: true };
	});

	register("im:reconnect-channel", async (data) => {
		const _provider = guardString(data.provider, "provider");
		const _appId = guardString(data.appId, "appId");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		try {
			await ctx.larkChannelManager.reconnect(_provider, _appId);
			return { success: true };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	register("im:send-test-message", async (data) => {
		const receiveIdType = guardString(data.receiveIdType, "receiveIdType");
		const receiveId = guardString(data.receiveId, "receiveId");
		const text = guardString(data.text, "text");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		return await ctx.larkChannelManager.sendTestMessage({ receiveIdType, receiveId, text });
	});

	register("im:test-connection", async (data) => {
		const appId = guardString(data.appId, "appId");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		return await ctx.larkChannelManager.testConnection(appId);
	});

	register("im:test-connection-direct", async (data) => {
		const appId = guardString(data.appId, "appId");
		const appSecret = guardString(data.appSecret, "appSecret");
		guardOptionalString(data.name, "name");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		return await ctx.larkChannelManager.testConnectionDirect(appId, appSecret);
	});

	register("im:update-channel", async (data) => {
		const appId = guardString(data.appId, "appId");
		guardOptionalString(data.name, "name");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		await ctx.larkChannelManager.updateChannel(appId, { name: data.name });
		return { success: true };
	});

	register("im:get-bindings", async () => {
		if (!ctx.larkBridgeService) {
			return { success: false, error: "LarkBridgeService is not available" };
		}
		return { success: true, bindings: ctx.larkBridgeService.getBindings() };
	});

	register("im:remove-binding", async (data) => {
		const chatId = guardString(data.chatId, "chatId");
		if (!ctx.larkBridgeService) {
			return { success: false, error: "LarkBridgeService is not available" };
		}
		ctx.larkBridgeService.removeBinding(chatId);
		return { success: true };
	});

	register("im:get-bridge-status", async () => {
		if (!ctx.larkBridgeService) {
			return { success: false, error: "LarkBridgeService is not available" };
		}
		return { success: true, ...ctx.larkBridgeService.getStatus() };
	});
};
