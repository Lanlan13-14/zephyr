package agent

import (
	"strings"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
)

// Run modes (S8) + collab modes (plan/goal).
//
// Collab:
//   plan     — read-only + plan_* only
//   goal     — full tools + goal system suffix
//   standard — full tools
//
// Economy / Balanced / Delivery (Reasonix-style tool surface):
//   economy  — minimal discover + connect + read terminal/workspace
//   balanced — current complete catalog (default)
//   delivery — complete + prefer verify/history tools (no extra deny)

// FilterToolsForMode returns a new registry with tools allowed for the mode.
func FilterToolsForMode(src *tool.Registry, mode string) *tool.Registry {
	if src == nil {
		return tool.NewRegistry()
	}
	m := strings.ToLower(strings.TrimSpace(mode))
	if m == "" || m == "standard" || m == "goal" || m == "balanced" || m == "delivery" {
		return src
	}
	if m == "economy" {
		return filterEconomy(src)
	}
	if m != "plan" {
		return src
	}
	out := tool.NewRegistry()
	for _, t := range src.List() {
		name := t.Name()
		if t.ReadOnly() || isPlanTool(name) || isHistoryTool(name) {
			// still block clearly destructive even if mis-marked
			if isDestructiveName(name) && !isPlanTool(name) {
				continue
			}
			// plan mode: only readonly subagents
			if isSubagentTool(name) && name != "subagent_list_profiles_v1" && name != "subagent_task_v1" && name != "subagent_parallel_v1" {
				continue
			}
			_ = out.Register(t)
		}
	}
	return out
}

func filterEconomy(src *tool.Registry) *tool.Registry {
	allow := map[string]bool{
		"capability_search":  true,
		"connection_list_v1": true, "connection_get_v1": true, "connection_open_v1": true, "connection_test_v1": true,
		"terminal_read_v1": true, "terminal_send_v1": true, "terminal_wait_v1": true,
		"remote_execute": true, "remote_read_file": true,
		"workspace_list_v1": true, "workspace_read_v1": true, "workspace_write_v1": true,
		"user_attachment_read_v1": true, "user_attachment_view_v1": true,
		"session_exec_v1": true, "session_sandbox_status_v1": true,
		"memory_search": true, "list_env_vars": true,
		"note_list": true, "note_search": true, "note_get": true,
		"subagent_list_profiles_v1": true, "subagent_task_v1": true, "subagent_parallel_v1": true,
		"remote_desktop_capture_v1": true, "remote_desktop_action_v1": true, "remote_desktop_verify_v1": true,
		"plan_task": true, "plan_update": true,
		"history_search": true, "history_get": true,
	}
	out := tool.NewRegistry()
	for _, t := range src.List() {
		if allow[t.Name()] {
			_ = out.Register(t)
		}
	}
	return out
}

func isPlanTool(name string) bool {
	return name == "plan_task" || name == "plan_update" || name == "plan_delete" ||
		strings.HasPrefix(name, "plan_")
}

func isHistoryTool(name string) bool {
	return name == "history_search" || name == "history_get"
}

func isSubagentTool(name string) bool {
	return strings.HasPrefix(name, "subagent_")
}

func isDestructiveName(name string) bool {
	n := strings.ToLower(name)
	return strings.Contains(n, "delete") || strings.Contains(n, "write") ||
		strings.Contains(n, "execute") || n == "remote_execute" ||
		strings.HasPrefix(n, "connection_create") || strings.HasPrefix(n, "connection_update")
}

// ModeSystemSuffix is appended to system prompt for plan/goal/economy/delivery.
// Does not replace standing assembly (stable prefix may intentionally break cache on mode switch).
func ModeSystemSuffix(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "plan":
		return "\n\n[协作模式: Plan]\n当前为计划模式：只能使用只读工具与 plan_task/plan_update 产出可执行计划。" +
			"不要执行远程写文件、远程命令、删除资产或会改变系统状态的操作。" +
			"子代理仅可派发只读 profile。计划完成后用清晰步骤列出目标/命令/风险/验证方式，等待用户确认后再在标准模式执行。"
	case "goal":
		return "\n\n[协作模式: Goal]\n当前为 Goal 模式：把用户目标当作任务合约，持续推进直到完成定义满足或必须暂停询问。" +
			"每轮结束检查：目标是否达成、证据是否足够、是否触及不可逆操作需确认。" +
			"未完成且无 pause 条件时继续使用工具；完成后明确给出完成结论与证据摘要。" +
			"可使用 subagent_parallel_v1 做只读勘察。"
	case "economy":
		return "\n\n[运行模式: Economy]\n工具面已收缩为最小发现/连接/终端/工作区/远程读执行。" +
			"优先少步完成；避免浏览器全量自动化与资产写操作，除非用户明确要求。"
	case "delivery":
		return "\n\n[运行模式: Delivery]\n高可靠交付：每步关键变更后做验证（读回文件、capture/verify、命令 exitCode）。" +
			"不可逆操作必须确认；完成时给出证据清单。"
	default:
		return ""
	}
}
