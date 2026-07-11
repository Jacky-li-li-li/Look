// ============================================================
// User Profile Service — local ~/.look/user-profile.json
// ============================================================

import { getUserProfilePath } from "@look/shared/look-storage";
import { readJsonFile, writeJsonFile } from "../utils/atomic-writer.js";

export interface UserProfile {
	userId: string;
	email: string;
	userName: string;
	avatar: string;
}

const DEFAULT_PROFILE: UserProfile = {
	userId: "",
	email: "",
	userName: "You",
	avatar: "",
};

function readRaw(): Partial<UserProfile> {
	return readJsonFile<Partial<UserProfile>>(getUserProfilePath(), {});
}

function writeRaw(profile: UserProfile): void {
	writeJsonFile(getUserProfilePath(), profile);
}

export function getUserProfile(): UserProfile {
	return { ...DEFAULT_PROFILE, ...readRaw() };
}

export function updateUserProfile(patch: Partial<UserProfile>): UserProfile {
	const current = getUserProfile();
	const merged = { ...current, ...patch };
	writeRaw(merged);
	return merged;
}

export function resetUserProfile(): UserProfile {
	writeRaw(DEFAULT_PROFILE);
	return { ...DEFAULT_PROFILE };
}
