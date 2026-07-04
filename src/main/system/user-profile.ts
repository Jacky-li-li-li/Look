// ============================================================
// User Profile Service — local ~/.look/user-profile.json
// Referencing Proma's user-profile-service.ts pattern
// ============================================================

import fs from "fs";
import { getUserProfilePath } from "../shared/look-storage.js";

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
	try {
		const raw = fs.readFileSync(getUserProfilePath(), "utf-8");
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

function writeRaw(profile: UserProfile): void {
	fs.writeFileSync(getUserProfilePath(), JSON.stringify(profile, null, "\t"), "utf-8");
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
