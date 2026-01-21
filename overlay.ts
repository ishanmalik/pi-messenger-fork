/**
 * Pi Messenger - Chat Overlay Component
 */

import { randomUUID } from "node:crypto";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  MAX_CHAT_HISTORY,
  formatRelativeTime,
  coloredAgentName,
  stripAnsiCodes,
  extractFolder,
  truncatePathLeft,
  getDisplayMode,
  type MessengerState,
  type Dirs,
  type AgentMailMessage,
  type AgentRegistration,
} from "./lib.js";
import * as store from "./store.js";

export class MessengerOverlay implements Component, Focusable {
  focused = false;

  private selectedAgent: string | null = null;
  private inputText = "";
  private scrollPosition = 0;
  private cachedAgents: AgentRegistration[] | null = null;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private state: MessengerState,
    private dirs: Dirs,
    private done: () => void
  ) {
    const agents = this.getAgentsSorted();
    const withUnread = agents.find(a => (state.unreadCounts.get(a.name) ?? 0) > 0);
    this.selectedAgent = withUnread?.name ?? agents[0]?.name ?? null;

    if (this.selectedAgent) {
      state.unreadCounts.set(this.selectedAgent, 0);
    }
  }

  private getAgentsSorted(): AgentRegistration[] {
    if (this.cachedAgents) return this.cachedAgents;
    this.cachedAgents = store.getActiveAgents(this.state, this.dirs).sort((a, b) => a.name.localeCompare(b.name));
    return this.cachedAgents;
  }

  private getMessages(): AgentMailMessage[] {
    if (this.selectedAgent === null) {
      return this.state.broadcastHistory;
    }
    return this.state.chatHistory.get(this.selectedAgent) ?? [];
  }

  private selectTab(agentName: string | null): void {
    this.selectedAgent = agentName;
    if (agentName) {
      this.state.unreadCounts.set(agentName, 0);
    }
    this.scrollPosition = 0;
  }

  private scroll(delta: number): void {
    const messages = this.getMessages();
    const maxScroll = Math.max(0, messages.length - 1);
    this.scrollPosition = Math.max(0, Math.min(maxScroll, this.scrollPosition + delta));
  }

  handleInput(data: string): void {
    const agents = this.getAgentsSorted();

    if (agents.length === 0) {
      if (matchesKey(data, "escape")) {
        this.done();
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      this.done();
      return;
    }

    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.cycleTab(1, agents);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
      this.cycleTab(-1, agents);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up")) {
      this.scroll(1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      this.scroll(-1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "home")) {
      const messages = this.getMessages();
      this.scrollPosition = Math.max(0, messages.length - 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "end")) {
      this.scrollPosition = 0;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "enter")) {
      if (this.inputText.trim()) {
        this.sendMessage(agents);
      }
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.inputText.length > 0) {
        this.inputText = this.inputText.slice(0, -1);
        this.tui.requestRender();
      }
      return;
    }

    if (data.length > 0 && data.charCodeAt(0) >= 32) {
      this.inputText += data;
      this.tui.requestRender();
    }
  }

  private cycleTab(direction: number, agents: AgentRegistration[]): void {
    const tabNames = [...agents.map(a => a.name), null];
    const currentIdx = this.selectedAgent === null
      ? tabNames.length - 1
      : tabNames.indexOf(this.selectedAgent);

    const newIdx = (currentIdx + direction + tabNames.length) % tabNames.length;
    this.selectTab(tabNames[newIdx]);
  }

  private sendMessage(agents: AgentRegistration[]): void {
    const text = this.inputText.trim();
    if (!text) return;

    if (this.selectedAgent === null) {
      // Broadcast: best-effort delivery to all agents
      for (const agent of agents) {
        try {
          store.sendMessageToAgent(this.state, this.dirs, agent.name, text);
        } catch {
          // Ignore individual failures
        }
      }
      // Store broadcast message regardless of send failures
      const broadcastMsg: AgentMailMessage = {
        id: randomUUID(),
        from: this.state.agentName,
        to: "broadcast",
        text,
        timestamp: new Date().toISOString(),
        replyTo: null
      };
      this.state.broadcastHistory.push(broadcastMsg);
      if (this.state.broadcastHistory.length > MAX_CHAT_HISTORY) {
        this.state.broadcastHistory.shift();
      }
      this.inputText = "";
      this.scrollPosition = 0;
      this.tui.requestRender();
    } else {
      // Regular send: keep input on failure so user can retry
      try {
        const msg = store.sendMessageToAgent(this.state, this.dirs, this.selectedAgent, text);
        let history = this.state.chatHistory.get(this.selectedAgent);
        if (!history) {
          history = [];
          this.state.chatHistory.set(this.selectedAgent, history);
        }
        history.push(msg);
        if (history.length > MAX_CHAT_HISTORY) history.shift();
        this.inputText = "";
        this.scrollPosition = 0;
        this.tui.requestRender();
      } catch {
        // On error, keep input text so user can retry
      }
    }
  }

  render(width: number): string[] {
    this.cachedAgents = null;  // Clear cache at start of render cycle
    const innerWidth = width - 4;
    const totalHeight = Math.floor(this.tui.terminal.rows * 0.45);
    const agents = this.getAgentsSorted();

    if (this.selectedAgent && !agents.find(a => a.name === this.selectedAgent)) {
      this.selectedAgent = agents[0]?.name ?? null;
    }

    const lines: string[] = [];

    lines.push(this.renderTitleBar(innerWidth, agents.length));

    if (agents.length === 0) {
      const emptyLines = this.renderEmptyState(innerWidth, Math.max(1, totalHeight - 2));
      lines.push(...emptyLines);
    } else {
      lines.push(this.renderTabBar(innerWidth, agents));
      lines.push(this.theme.fg("dim", "─".repeat(innerWidth)));

      const messageAreaHeight = Math.max(1, totalHeight - 5);
      const messageLines = this.renderMessages(innerWidth, messageAreaHeight, agents);
      lines.push(...messageLines);

      lines.push(this.theme.fg("dim", "─".repeat(innerWidth)));
      lines.push(this.renderInputBar(innerWidth));
    }

    return lines;
  }

  private renderTitleBar(width: number, peerCount: number): string {
    const label = this.theme.fg("accent", "Messenger");
    const name = coloredAgentName(this.state.agentName);
    const peers = this.theme.fg("dim", `${peerCount} peer${peerCount === 1 ? "" : "s"}`);

    const content = `${label} ── ${name} ── ${peers}`;
    return truncateToWidth(content, width);
  }

  private renderTabBar(width: number, agents: AgentRegistration[]): string {
    const parts: string[] = [];
    const mode = getDisplayMode(agents);

    for (const agent of agents) {
      const isSelected = this.selectedAgent === agent.name;
      const unread = this.state.unreadCounts.get(agent.name) ?? 0;

      let tab = isSelected ? "▸ " : "";
      tab += "● ";
      tab += coloredAgentName(agent.name);

      if (mode === "same-folder") {
        if (agent.gitBranch) {
          tab += `:${agent.gitBranch}`;
        }
      } else if (mode === "different") {
        tab += `/${extractFolder(agent.cwd)}`;
      }

      if (unread > 0 && !isSelected) {
        tab += ` (${unread})`;
      }

      parts.push(tab);
    }

    const isAllSelected = this.selectedAgent === null;
    let allTab = isAllSelected ? "▸ " : "";
    allTab += this.theme.fg("accent", "+ All");
    parts.push(allTab);

    const content = parts.join(" │ ");
    return truncateToWidth(content, width);
  }

  private renderEmptyState(width: number, height: number): string[] {
    const lines: string[] = [];
    const msg1 = "No other agents active";
    const msg2 = "Start another pi instance to chat";

    const padTop = Math.floor((height - 2) / 2);
    for (let i = 0; i < padTop; i++) lines.push("");

    const pad1 = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(msg1)) / 2)));
    const pad2 = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(msg2)) / 2)));

    lines.push(pad1 + msg1);
    lines.push("");
    lines.push(pad2 + this.theme.fg("dim", msg2));

    while (lines.length < height) lines.push("");
    return lines;
  }

  private renderMessages(width: number, height: number, agents: AgentRegistration[]): string[] {
    const messages = this.getMessages();

    if (messages.length === 0) {
      return this.renderNoMessages(width, height, agents);
    }

    const maxVisibleMessages = Math.max(1, Math.floor(height / 3));
    const endIdx = messages.length - this.scrollPosition;
    const startIdx = Math.max(0, endIdx - maxVisibleMessages);
    const visibleMessages = messages.slice(startIdx, endIdx);

    const allRenderedLines: string[] = [];
    for (const msg of visibleMessages) {
      const msgLines = this.renderMessageBox(msg, width - 2);
      allRenderedLines.push(...msgLines);
    }

    if (allRenderedLines.length > height) {
      return allRenderedLines.slice(allRenderedLines.length - height);
    }

    while (allRenderedLines.length < height) {
      allRenderedLines.unshift("");
    }
    return allRenderedLines;
  }

  private renderNoMessages(width: number, height: number, agents: AgentRegistration[]): string[] {
    const lines: string[] = [];

    if (this.selectedAgent === null) {
      const msg = "No broadcasts sent yet";
      const padTop = Math.floor((height - 1) / 2);
      for (let i = 0; i < padTop; i++) lines.push("");
      const pad = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(msg)) / 2)));
      lines.push(pad + this.theme.fg("dim", msg));
    } else {
      const agent = agents.find(a => a.name === this.selectedAgent);
      const msg1 = `No messages with ${this.selectedAgent}`;

      const details: string[] = [];
      if (agent) {
        const folder = extractFolder(agent.cwd);
        const infoParts = [folder];
        if (agent.gitBranch) infoParts.push(agent.gitBranch);
        infoParts.push(agent.model);
        infoParts.push(formatRelativeTime(agent.startedAt));
        details.push(infoParts.join(" • "));

        if (agent.reservations && agent.reservations.length > 0) {
          for (const r of agent.reservations) {
            details.push(`🔒 ${truncatePathLeft(r.pattern, 40)}`);
          }
        }
      }

      const totalLines = 1 + details.length + 1;
      const padTop = Math.floor((height - totalLines) / 2);
      for (let i = 0; i < padTop; i++) lines.push("");

      const pad1 = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(msg1)) / 2)));
      lines.push(pad1 + msg1);
      lines.push("");

      for (const detail of details) {
        const pad = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(detail)) / 2)));
        lines.push(pad + this.theme.fg("dim", detail));
      }
    }

    while (lines.length < height) lines.push("");
    return lines;
  }

  private renderMessageBox(msg: AgentMailMessage, maxWidth: number): string[] {
    const isOutgoing = msg.from === this.state.agentName;
    const senderLabel = isOutgoing
      ? (msg.to === "broadcast" ? "You → All" : "You")
      : stripAnsiCodes(msg.from);
    const senderColored = isOutgoing
      ? this.theme.fg("accent", senderLabel)
      : coloredAgentName(msg.from);

    const timeStr = formatRelativeTime(msg.timestamp);
    const time = this.theme.fg("dim", timeStr);
    const safeText = stripAnsiCodes(msg.text);

    const boxWidth = Math.min(maxWidth, 60);
    const contentWidth = boxWidth - 4;

    const wrappedLines = this.wrapText(safeText, contentWidth);

    const headerLeft = `┌─ ${senderColored} `;
    const headerRight = ` ${time} ─┐`;
    const headerLeftLen = 4 + visibleWidth(senderLabel);
    const headerRightLen = visibleWidth(timeStr) + 4;
    const dashCount = Math.max(0, boxWidth - headerLeftLen - headerRightLen);

    const lines: string[] = [];
    lines.push(headerLeft + "─".repeat(dashCount) + headerRight);

    for (const line of wrappedLines) {
      const padRight = contentWidth - visibleWidth(line);
      lines.push(`│ ${line}${" ".repeat(Math.max(0, padRight))} │`);
    }

    lines.push(`└${"─".repeat(boxWidth - 2)}┘`);
    lines.push("");

    return lines;
  }

  private wrapText(text: string, maxWidth: number): string[] {
    const result: string[] = [];
    const paragraphs = text.split("\n");

    for (const para of paragraphs) {
      if (para === "") {
        result.push("");
        continue;
      }

      const words = para.split(" ");
      let currentLine = "";

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (visibleWidth(testLine) <= maxWidth) {
          currentLine = testLine;
        } else {
          if (currentLine) result.push(currentLine);
          if (visibleWidth(word) > maxWidth) {
            currentLine = truncateToWidth(word, maxWidth - 1) + "…";
          } else {
            currentLine = word;
          }
        }
      }

      if (currentLine) result.push(currentLine);
    }

    return result.length > 0 ? result : [""];
  }

  private renderInputBar(width: number): string {
    const prompt = this.theme.fg("accent", "> ");

    let placeholder: string;
    if (this.selectedAgent === null) {
      placeholder = "Broadcast to all agents...";
    } else {
      placeholder = `Message ${this.selectedAgent}...`;
    }

    const hint = this.theme.fg("dim", "[Tab] [Enter]");
    const hintLen = visibleWidth("[Tab] [Enter]");

    if (this.inputText) {
      const maxInputLen = width - 2 - hintLen - 2;
      const displayText = truncateToWidth(this.inputText, maxInputLen);
      const padLen = width - 2 - visibleWidth(displayText) - hintLen;
      return prompt + displayText + " ".repeat(Math.max(0, padLen)) + hint;
    } else {
      const displayPlaceholder = truncateToWidth(placeholder, width - 2 - hintLen - 2);
      const padLen = width - 2 - visibleWidth(displayPlaceholder) - hintLen;
      return prompt + this.theme.fg("dim", displayPlaceholder) + " ".repeat(Math.max(0, padLen)) + hint;
    }
  }

  invalidate(): void {
    // No cached state to invalidate
  }

  dispose(): void {}
}
