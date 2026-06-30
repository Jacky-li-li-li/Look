// ============================================================
// Sidebar/types — 共享类型
// ============================================================

import type { AgentInfo, ProjectInfo } from "@shared/types";
import type React from "react";

export interface SidebarProps {
	onSelect: (agentId: string) => void;
	onDestroy: (agentId: string) => void;
	onCreateClick: (projectId: string) => void;
	onSettingsClick: () => void;
	onCreateProject: () => void;
	onDeleteProject: (project: ProjectInfo) => void;
	onOpenProject: (projectId: string) => void;
	onRenameProject: (projectId: string, name: string) => void;
}

export interface ProjectHeaderProps {
	project: ProjectInfo;
	isOpen: boolean;
	editingProjectId: string | null;
	editRef: React.RefObject<HTMLInputElement | null>;
	editValue: string;
	setEditValue: (v: string) => void;
	commitEdit: () => void;
	handleEditKeyDown: (e: React.KeyboardEvent) => void;
	beginEdit: (kind: "project" | "session", id: string, value: string) => void;
	onCreateClick: (id: string) => void;
	onOpenProject: (id: string) => void;
	onDeleteProject: (project: ProjectInfo) => void;
}

export interface SessionRowProps {
	agent: AgentInfo;
	isActive: boolean;
	isRunning: boolean;
	phase: string;
	isCompleted: boolean;
	editingSessionId: string | null;
	editRef: React.RefObject<HTMLInputElement | null>;
	editValue: string;
	setEditValue: (v: string) => void;
	commitEdit: () => void;
	handleEditKeyDown: (e: React.KeyboardEvent) => void;
	beginEdit: (kind: "project" | "session", id: string, value: string) => void;
	selectSession: (agent: AgentInfo) => void;
	collapsedSubSessions: Set<string>;
	toggleSubSessions: (parentId: string, e: React.MouseEvent) => void;
	childrenList: AgentInfo[];
	copySessionId: (id: string) => Promise<void>;
	exportSession: (id: string) => Promise<void>;
	onDestroy: (id: string) => void;
}

export interface ProjectTreeProps {
	onSelect: (agentId: string) => void;
	onDestroy: (agentId: string) => void;
	onCreateClick: (projectId: string) => void;
	onDeleteProject: (project: ProjectInfo) => void;
	onOpenProject: (projectId: string) => void;
	onRenameProject: (projectId: string, name: string) => void;
}
