// CompositionBuilder phase
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getAuthPath, getCustomProvidersPath, getModelsPath } from "@look/shared/look-storage";
import { EncryptedCredentialStore } from "../../../security/secrets.js";
import { AutoTitleService } from "../../../services/auto-title.js";
import { CustomProvidersStore } from "../../../settings/custom-providers.js";
import type { CompositionBuilder } from "../builder-context.js";

export async function buildModelPhase(b: CompositionBuilder): Promise<void> {
	const credentials = new EncryptedCredentialStore(getAuthPath());
	b.credentialStore = credentials;
	b.modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: getModelsPath(),
		// 启动只做本地磁盘加载：网络刷新（最长 15s）若在此 await 会挡住
		// IPC 注册与项目加载，冷启动时侧边栏长时间为空。网络刷新由
		// Application 在启动序列完成后后台补齐并广播 model:updated。
		allowModelNetwork: false,
	});
	b.modelRegistry = new ModelRegistry(b.modelRuntime);

	b.customProviders = new CustomProvidersStore(b.modelRuntime, getCustomProvidersPath());
	b.customProviders.load();

	b.autoTitleService = new AutoTitleService({
		modelRuntime: b.modelRuntime,
		getUserSettings: () => b.req(b.userSettings, "userSettings").getAll(),
	});
}
