// ============================================================
// SettingsDialog — Flex layout + inline expand (Ink Wash)
// ============================================================

import React, { useState, useEffect, useCallback } from "react";
import { useTheme } from "next-themes";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@shared/components/ui/dialog";
import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { Badge } from "@shared/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@shared/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@shared/components/ui/tabs";
import { Switch } from "@shared/components/ui/switch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@shared/components/ui/select";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@shared/components/ui/collapsible";
import {
  Check, Key, Eye, EyeOff, X, Sun, Moon, Palette, Zap, Trash2, Cpu, Settings,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@shared/lib/utils";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

const api = (window as any).harness;

interface ProviderInfo {
  id: string; name: string; hasKey: boolean; envVar: string; modelsAvailable: number;
  authSource?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  envLabel?: string;
}

interface SettingsDialogProps {
  open: boolean;
  providers: ProviderInfo[];
  onProvidersChange: (providers: ProviderInfo[]) => void;
  onClose: () => void;
}



const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

// ── Reusable setting row ──
function SettingRow({ label, desc, id, children }: {
  label: string; desc: string; id?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="flex flex-col gap-0.5 min-w-0">
        <label htmlFor={id} className="text-[13px] font-medium leading-none cursor-pointer">
          {label}
        </label>
        <span className="text-[11px] text-muted-foreground leading-tight">{desc}</span>
      </div>
      {children}
    </div>
  );
}

function SettingsDialogImpl({ open, providers, onProvidersChange, onClose }: SettingsDialogProps) {
  const { theme, setTheme } = useTheme();
  const [language, setLanguage] = useState("en");
  const [thinkingLevel, setThinkingLevel] = useState("medium");
  const [autoCollapse, setAutoCollapse] = useState(true);
  const [autoCompress, setAutoCompress] = useState(false);
  const [compressThreshold, setCompressThreshold] = useState(60);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Load persisted settings on mount
  useEffect(() => {
    if (!api) return;
    api.getGeneralSettings().then((r: any) => {
      if (r?.success && r.settings) {
        if (r.settings.language) setLanguage(r.settings.language);
        if (r.settings.defaultThinkingLevel) setThinkingLevel(r.settings.defaultThinkingLevel);
        if (r.settings.autoCollapse !== undefined) setAutoCollapse(r.settings.autoCollapse);
        if (r.settings.autoCompress !== undefined) setAutoCompress(r.settings.autoCompress);
        if (r.settings.compressThreshold !== undefined) setCompressThreshold(r.settings.compressThreshold);
        setSettingsLoaded(true);
      }
    }).catch(() => setSettingsLoaded(true));
  }, []);

  const [editing, setEditing] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset inline editing state when dialog opens
  useEffect(() => { setEditing(null); setKeyInput(""); setShowKey(false); }, [open]);

  const appVersion = "1.0.0";

  // Providers are now hoisted to App.tsx and passed in as a prop — avoids the
  // IPC + main-process model-registry walk on every dialog open.
  const loading = providers.length === 0 && !!api;

  const handleSave = async () => {
    if (!editing || !api || !keyInput.trim()) return;
    setSaving(true);
    try {
      const result = await api.setApiKey(editing, keyInput.trim());
      if (result?.success) {
        onProvidersChange(result.providers);
        toast.success(`${editing} key updated`);
      }
    } catch (e: any) { toast.error(e?.message ?? "Failed to save key"); }
    setSaving(false);
    setEditing(null); setKeyInput(""); setShowKey(false);
  };

  const handleClearKey = async (providerId: string) => {
    if (!api) return;
    try {
      const result = await api.setApiKey(providerId, "");
      if (result?.success) { onProvidersChange(result.providers); toast.success(`${providerId} key removed`); }
    } catch (e: any) { toast.error(e?.message ?? "Failed to clear key"); }
  };

  // Persist settings to main process
  const persistSettings = useCallback((partial: Record<string, any>) => {
    if (!api) return;
    api.setGeneralSettings(partial).catch(() => {});
  }, []);

  const handleResetDefaults = () => {
    if (api) api.resetGeneralSettings().then((r: any) => {
      if (r?.success && r.settings) {
        setLanguage(r.settings.language ?? "en");
        setThinkingLevel(r.settings.defaultThinkingLevel ?? "medium");
        setAutoCollapse(r.settings.autoCollapse ?? true);
        setAutoCompress(r.settings.autoCompress ?? false);
        setCompressThreshold(r.settings.compressThreshold ?? 60);
      }
    });
    setTheme("dark");
    toast.success("Settings reset to defaults");
  };

  const configured = providers.filter(p => p.hasKey).length;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        forceMount
        className="flex max-h-[82vh] flex-col sm:max-w-xl data-[state=closed]:hidden"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Customize appearance, manage API keys, and more.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="w-full shrink-0">
            <TabsTrigger value="general" className="flex-1">
              <Palette data-icon="inline-start" className="size-3.5" />
              General
            </TabsTrigger>
            <TabsTrigger value="api-keys" className="flex-1">
              <Key data-icon="inline-start" className="size-3.5" />
              API Keys
              {configured > 0 && (
                <Badge variant="secondary" className="ml-1 h-4 px-1 text-[9px]">{configured}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="about" className="flex-1">
              <Zap data-icon="inline-start" className="size-3.5" />
              About
            </TabsTrigger>
          </TabsList>

          {/* ─── General ─── */}
          <TabsContent value="general" className="flex-1 overflow-y-auto pt-4 data-[state=inactive]:hidden">
            <div className="flex flex-col gap-3 pr-1">
              <Card size="sm">
                <CardHeader className="border-b border-hairline px-4 py-2.5">
                  <CardTitle className="flex items-center gap-1.5 text-[13px]">
                    <Sun className="size-3.5 text-muted-foreground" />
                    Appearance
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
                  <SettingRow id="theme" label="Theme" desc={theme === "dark" ? "Dark mode" : "Light mode"}>
                    <div className="flex items-center gap-1.5">
                      <Sun className="size-3.5 text-muted-foreground" />
                      <Switch id="theme" size="sm" checked={theme === "dark"} onCheckedChange={(c) => setTheme(c ? "dark" : "light")} />
                      <Moon className="size-3.5 text-muted-foreground" />
                    </div>
                  </SettingRow>
                  <SettingRow id="language" label="Language" desc="Interface language">
                    <Select value={language} onValueChange={(v) => { setLanguage(v); persistSettings({ language: v }); }}>
                      <SelectTrigger id="language" size="sm" className="w-[110px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="en">English</SelectItem>
                          <SelectItem value="zh">中文</SelectItem>
                          <SelectItem value="ja">日本語</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </SettingRow>
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader className="border-b border-hairline px-4 py-2.5">
                  <CardTitle className="flex items-center gap-1.5 text-[13px]">
                    <Cpu className="size-3.5 text-muted-foreground" />
                    Behavior
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
                  <SettingRow id="thinking" label="Default Thinking" desc="Reasoning depth for new agents">
                    <Select value={thinkingLevel} onValueChange={(v) => { setThinkingLevel(v); persistSettings({ defaultThinkingLevel: v }); }}>
                      <SelectTrigger id="thinking" size="sm" className="w-[100px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {THINKING_LEVELS.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </SettingRow>
                  <SettingRow id="autoclp" label="Auto-collapse" desc="Collapse steps after completion">
                    <Switch id="autoclp" size="sm" checked={autoCollapse} onCheckedChange={(v) => { setAutoCollapse(v); persistSettings({ autoCollapse: v }); }} />
                  </SettingRow>
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader className="border-b border-hairline px-4 py-2.5">
                  <CardTitle className="flex items-center gap-1.5 text-[13px]">
                    <Zap className="size-3.5 text-muted-foreground" />
                    Compression
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
                  <SettingRow id="autocompress" label="Auto-compress" desc="Compact context when threshold reached">
                    <Switch id="autocompress" size="sm" checked={autoCompress} onCheckedChange={(v) => { setAutoCompress(v); persistSettings({ autoCompress: v }); }} />
                  </SettingRow>
                  <SettingRow id="compressThreshold" label="Compress at" desc={`Auto-compress when context exceeds ${compressThreshold}%`}>
                    <div className="flex items-center gap-2">
                      <input
                        id="compressThreshold"
                        type="range"
                        min={40}
                        max={95}
                        step={5}
                        value={compressThreshold}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setCompressThreshold(v);
                          persistSettings({ compressThreshold: v });
                        }}
                        className="w-20 h-1.5 cursor-pointer accent-foreground appearance-none rounded-full bg-muted-foreground/20 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground"
                      />
                      <span className="w-8 text-right text-[11px] font-mono tabular-nums text-muted-foreground">{compressThreshold}%</span>
                    </div>
                  </SettingRow>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ─── API Keys ─── */}
          <TabsContent value="api-keys" className="flex-1 overflow-y-auto pt-4 data-[state=inactive]:hidden">
            {loading ? (
              <div className="flex items-center justify-center py-12 text-[12px] text-muted-foreground">Loading providers…</div>
            ) : (
              <div className="flex flex-col gap-0.5 pr-1">
                {providers.map((p) => {
                  const isEditing = editing === p.id;
                  // A provider may have a working key (e.g. shell env var) but
                  // still be "unconfigured" from the app's perspective. Show
                  // a small hint in that case so the user knows why.
                  const envOnly = !p.hasKey && p.authSource === "environment";
                  return (
                    <div key={p.id}>
                      {/* Provider row */}
                      <div className={cn(
                        "flex items-center justify-between gap-3 rounded-lg px-3 py-2 transition-colors",
                        p.hasKey && !isEditing ? "bg-muted/30" : "hover:bg-muted/20",
                        isEditing && "rounded-b-none bg-muted/40"
                      )}>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-[13px] font-medium">
                            <span className={cn("size-2 rounded-full shrink-0", p.hasKey ? "bg-emerald-500" : "bg-muted-foreground/30")} />
                            {p.name}
                            {p.hasKey ? (
                              <Badge variant="outline" className="h-4.5 gap-1 px-1.5 text-[10px]">
                                <Check className="size-2.5" />{p.modelsAvailable}
                              </Badge>
                            ) : envOnly ? (
                              <Badge variant="secondary" className="h-4.5 gap-1 px-1.5 text-[10px]" title={p.envLabel ? `Detected from $${p.envLabel} in environment` : "Detected from environment"}>
                                env
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="h-4.5 px-1.5 text-[10px]">—</Badge>
                            )}
                          </div>
                          <code className="mt-0.5 block text-[10px] text-muted-foreground font-mono">{p.envVar}</code>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant={isEditing ? "line-filled" : p.hasKey ? "line" : "line-filled"}
                            size="xs"
                            className="h-7 text-[11px]"
                            onClick={() => {
                              if (isEditing) { setEditing(null); setKeyInput(""); }
                              else { setEditing(p.id); setKeyInput(""); setShowKey(false); }
                            }}
                          >
                            <Key data-icon="inline-start" className="size-3" />
                            {isEditing ? "Cancel" : p.hasKey ? "Edit" : "Set Key"}
                          </Button>
                          {p.hasKey && !isEditing && (
                            <Button variant="line-ghost" size="icon-xs" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => handleClearKey(p.id)}>
                              <Trash2 className="size-3" />
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* Inline expand editor */}
                      {isEditing && (
                        <div className="rounded-b-lg border border-t-0 border-hairline bg-muted/30 px-3 pb-3 pt-2">
                          <div className="flex gap-2">
                            <div className="relative flex-1">
                              <Input
                                type={showKey ? "text" : "password"}
                                value={keyInput}
                                onChange={(e) => setKeyInput(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleSave();
                                  if (e.key === "Escape") { setEditing(null); setKeyInput(""); setShowKey(false); }
                                }}
                                placeholder="sk-..."
                                autoFocus
                                className="pr-9 font-mono text-[12px] h-8"
                              />
                              <Button variant="ghost" size="icon" className="absolute right-0 top-0 size-8" onClick={() => setShowKey(!showKey)} tabIndex={-1}>
                                {showKey ? <EyeOff data-icon="inline-start" /> : <Eye data-icon="inline-start" />}
                              </Button>
                            </div>
                            <Button variant="line-filled" size="sm" className="h-8 text-[11px]" onClick={handleSave} disabled={saving || !keyInput.trim()}>
                              {saving ? "Saving…" : "Save"}
                            </Button>
                          </div>
                          <p className="mt-1.5 text-[10px] text-muted-foreground">
                            Or set <code className="rounded bg-muted px-1 font-mono text-[10px]">export {p.envVar}=...</code>
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
                {providers.length === 0 && (
                  <p className="py-8 text-center text-[12px] text-muted-foreground">No providers available.</p>
                )}
              </div>
            )}
          </TabsContent>

          {/* ─── About ─── */}
          <TabsContent value="about" className="flex-1 overflow-y-auto pt-4 data-[state=inactive]:hidden">
            <div className="flex flex-col items-center gap-5 px-4 py-10 text-center">
              <PixelAgentAvatar size="lg" active />
              <div className="flex flex-col items-center gap-1.5">
                <h2 className="text-lg font-semibold tracking-tight">Look</h2>
                <Badge variant="secondary" className="font-mono text-[11px]">v{appVersion}</Badge>
              </div>
              <p className="text-[13px] text-muted-foreground max-w-xs leading-relaxed">
                Multi-agent orchestration desktop application. Built with Electron, React, and pi SDK.
              </p>
              <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                <span className="flex items-center justify-center gap-1.5">
                  <Settings className="size-3" /> shadcn/ui + Radix
                </span>
                <span className="flex items-center justify-center gap-1.5">
                  <Palette className="size-3" /> Ink Wash design system
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground/60 font-mono">
                {configured} provider{configured !== 1 ? "s" : ""} configured · {providers.reduce((s, p) => s + p.modelsAvailable, 0)} models
              </p>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="shrink-0 sm:justify-between">
          <Button variant="line" size="sm" className="h-7 text-[11px]" onClick={handleResetDefaults}>
            Reset
          </Button>
          <Button variant="line-filled" size="sm" className="h-7 text-[11px]" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  );
}

const SettingsDialog = React.memo(SettingsDialogImpl);
export default SettingsDialog;
