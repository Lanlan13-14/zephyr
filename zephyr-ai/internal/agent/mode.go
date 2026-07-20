package agent

import (
	"strings"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
)

// FilterToolsForMode returns a new registry with tools allowed for the mode.
// plan: read-only + plan_* only (no writers, no remote_execute, no ui destructive).
// goal: all tools (goal is about continuation, not tool restriction).
// standard: all tools.
func FilterToolsForMode(src *tool.Registry, mode string) *tool.Registry {
	if src == nil {
		return tool.NewRegistry()
	}
	m := strings.ToLower(strings.TrimSpace(mode))
	if m == "" || m == "standard" || m == "goal" {
		return src
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

func isDestructiveName(name string) bool {
	n := strings.ToLower(name)
	return strings.Contains(n, "delete") || strings.Contains(n, "write") ||
		strings.Contains(n, "execute") || n == "remote_execute" ||
		strings.HasPrefix(n, "connection_create") || strings.HasPrefix(n, "connection_update")
}

// ModeSystemSuffix is appended to system prompt for plan/goal (does not replace assembly).
func ModeSystemSuffix(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "plan":
		return "\n\n[协作模式: Plan]\n当前为计划模式：只能使用只读工具与 plan_task/plan_update 产出可执行计划。" +
			"不要执行远程写文件、远程命令、删除资产或会改变系统状态的操作。" +
			"计划完成后用清晰步骤列出目标/命令/风险/验证方式，等待用户确认后再在标准模式执行。"
	case "goal":
		return "\n\n[协作模式: Goal]\n当前为 Goal 模式：把用户目标当作任务合约，持续推进直到完成定义满足或必须暂停询问。" +
			"每轮结束检查：目标是否达成、证据是否足够、是否触及不可逆操作需确认。" +
			"未完成且无 pause 条件时继续使用工具；完成后明确给出完成结论与证据摘要。"
	default:
		return ""
	}
}
