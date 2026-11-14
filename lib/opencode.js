"use strict";

/* Shared opencode.ai free-tier proxy logic.
 * Ported from 9Router (open-sse/executors/opencode.js + utils/opencodeFingerprint.js),
 * then updated for the current OpenCode 1.19.5 client.
 *
 * Upstream contract (verified live 2026-11-05):
 * - *-free -> POST {base}/inference/openai/v1/chat/completions (OpenAI Chat SSE)
 * - carry the current OpenCode tool definitions, UA, project/client headers and
 *   a session + message id whose hex prefix encodes a recent timestamp.
 * - the free tier rejects requests with more than 33 non-OpenCode tools using
 *   a misleading 429 FreeUsageLimitError. Keep the caller tool list at or
 *   below that budget and append the exact OpenCode fingerprint tools.
 * - the system prompt normally carries an OpenCode-style <env> block; it is
 *   metadata, not the only gate.
 * - the free tier also rate-limits hard, so the Bun runtime (same TLS/HTTP
 *   fingerprint as OpenCode) plus retry is used.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const UPSTREAM_BASE = (process.env.UPSTREAM_BASE_URL || "https://opencode.ai").replace(/\/+$/, "");
const CLIENT_UA =
  process.env.OPENCODE_UA || `opencode/1.19.5 ai-sdk/provider-utils/4.0.23 runtime/bun/${process.versions.bun || "1.4.4"}`;
const CLIENT_NAME = "cli";

// Free tier: any model whose id ends in "-free". Legacy muse-spark models are
// served by the Responses endpoint; the current free list uses Chat Completions.
function isResponsesModel(id) {
  const base = baseModel(id);
  const bare = base.includes("/") ? base.split("/").pop() : base;
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(bare);
}
function isAllowedModel(id) {
  const b = baseModel(id).toLowerCase();
  return !!b && /-free$/i.test(b);
}

/* ---------- exact OpenCode 1.19.5 fingerprint tools ---------- */
const FP_DEFS = {
  "bash": {
    "description": "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nBe aware: OS: linux, Shell: bash\n\nAll commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.\n\nUse `/tmp/opencode` for temporary work outside the workspace. This directory has already been created, already exists, and is pre-approved for external directory access.\n\nIMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location\n   - For example, before running \"mkdir foo/bar\", first use `ls foo` to check that \"foo\" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., rm \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - mkdir \"/Users/name/My Documents\" (correct)\n     - mkdir /Users/name/My Documents (incorrect - will fail)\n     - python \"/path/with spaces/script.py\" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after 120000ms.\n  - If the output exceeds 2000 lines or 51200 bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Grep to search the full content. Do NOT use `head`, `tail`, or other truncation commands to limit output; the full output will already be captured to a file for more precise searching.\n\n  - Avoid using Bash with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:\n    - File search: Use Glob (NOT find or ls)\n    - Content search: Use Grep (NOT grep or rg)\n    - Read files: Use Read (NOT cat/head/tail)\n    - Edit files: Use Edit (NOT sed/awk)\n    - Write files: Use Write (NOT echo >/cat <<EOF)\n    - Communication: Output text directly (NOT echo/printf)\n  - When issuing multiple commands:\n    - If the commands are independent and can run in parallel, make multiple bash tool calls in a single message. For example, if you need to run \"git status\" and \"git diff\", send a single message with two bash tool calls in parallel.\n    - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead.\n    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail\n    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)\n  - AVOID using `cd <directory> && <command>`. Use the `workdir` parameter to change directories instead.\n    <good-example>\n    Use workdir=\"/foo/bar\" with command: pytest tests\n    </good-example>\n    <bad-example>\n    cd /foo/bar && pytest tests\n    </bad-example>\n\n# Git and GitHub\n- Only commit, amend, push, or create PRs when explicitly requested.\n- Before committing, inspect `git status`, `git diff`, and `git log --oneline -10`; stage only intended files and never commit secrets.\n- Write a concise commit message that matches the repo style.\n- Do not update git config, skip hooks, use interactive `-i`, force-push, or create empty commits unless explicitly requested.\n- If a commit fails or hooks reject it, fix the issue and create a new commit; do not amend the failed commit.\n- Before creating a PR, inspect status, diff, remote tracking, recent commits, and the diff from the base branch.\n- Review all commits included in the PR, not just the latest commit.\n- Use `gh` for GitHub tasks, including PRs, issues, checks, and releases; return the PR URL when done.\n",
    "parameters": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "command": {
          "type": "string",
          "description": "The command to execute"
        },
        "timeout": {
          "minimum": -9007199254740991,
          "exclusiveMinimum": 0,
          "type": "integer",
          "maximum": 9007199254740991,
          "description": "Optional timeout in milliseconds"
        },
        "workdir": {
          "type": "string",
          "description": "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands."
        }
      },
      "required": [
        "command"
      ]
    }
  },
  "edit": {
    "description": "Performs exact string replacements in files. \n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. \n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + colon + space (e.g., `1: `). Everything after that space is the actual file content to match. Never include any part of the line number prefix in the oldString or newString.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `oldString` is not found in the file with an error \"oldString not found in content\".\n- The edit will FAIL if `oldString` is found multiple times in the file with an error \"Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match.\" Either provide a larger string with more surrounding context to make it unique or use `replaceAll` to change every instance of `oldString`. \n- Use `replaceAll` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.\n",
    "parameters": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "filePath": {
          "type": "string",
          "description": "The absolute path to the file to modify"
        },
        "oldString": {
          "type": "string",
          "description": "The text to replace"
        },
        "newString": {
          "type": "string",
          "description": "The text to replace it with (must be different from oldString)"
        },
        "replaceAll": {
          "type": "boolean",
          "description": "Replace all occurrences of oldString (default false)"
        }
      },
      "required": [
        "filePath",
        "oldString",
        "newString"
      ]
    }
  },
  "glob": {
    "description": "- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths\n- Use this tool when you need to find files by name patterns\n- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead\n- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.\n",
    "parameters": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string",
          "description": "The glob pattern to match files against"
        },
        "path": {
          "type": "string",
          "description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided."
        }
      },
      "required": [
        "pattern"
      ]
    }
  },
  "grep": {
    "description": "- Fast content search tool that works with any codebase size\n- Searches file contents using regular expressions\n- Supports full regex syntax (eg. \"log.*Error\", \"function\\s+\\w+\", etc.)\n- Filter files by pattern with the include parameter (eg. \"*.js\", \"*.{ts,tsx}\")\n- Returns file paths and line numbers with matching lines\n- Use this tool when you need to find files containing specific patterns\n- If you need to identify/count the number of matches within files, use the Bash tool with `rg` (ripgrep) directly. Do NOT use `grep`.\n- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead\n",
    "parameters": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string",
          "description": "The regex pattern to search for in file contents"
        },
        "path": {
          "type": "string",
          "description": "The directory to search in. Defaults to the current working directory."
        },
        "include": {
          "type": "string",
          "description": "File pattern to include in the search (e.g. \"*.js\", \"*.{ts,tsx}\")"
        }
      },
      "required": [
        "pattern"
      ]
    }
  },
  "read": {
    "description": "Read a file or directory from the local filesystem. If the path does not exist, an error is returned.\n\nUsage:\n- The filePath parameter should be an absolute path.\n- By default, this tool returns up to 2000 lines from the start of the file.\n- The offset parameter is the line number to start from (1-indexed).\n- To read later sections, call this tool again with a larger offset.\n- Use the grep tool to find specific content in large files or files with long lines.\n- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.\n- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents \"foo\\n\", you will receive \"1: foo\\n\". For directories, entries are returned one per line (without line numbers) with a trailing `/` for subdirectories.\n- Any line longer than 2000 characters is truncated.\n- Call this tool in parallel when you know there are multiple files you want to read.\n- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.\n- This tool can read image files and PDFs and return them as file attachments.\n",
    "parameters": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "filePath": {
          "type": "string",
          "description": "The absolute path to the file or directory to read"
        },
        "offset": {
          "minimum": 0,
          "type": "integer",
          "maximum": 9007199254740991,
          "description": "The line number to start reading from (1-indexed)"
        },
        "limit": {
          "minimum": 0,
          "type": "integer",
          "maximum": 9007199254740991,
          "description": "The maximum number of lines to read (defaults to 2000)"
        }
      },
      "required": [
        "filePath"
      ]
    }
  },
  "skill": {
    "description": "Load a specialized skill when the task at hand matches one of the skills listed in the system prompt.\n\nUse this tool to inject the skill's instructions and resources into current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc in the same directory as the skill.\n\nThe skill name must match one of the skills listed in your system prompt.\n",
    "parameters": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "The name of the skill from available_skills"
        }
      },
      "required": [
        "name"
      ]
    }
  },
  "task": {
    "description": "Launch a new agent to handle complex, multistep tasks autonomously.\n\nWhen using the Task tool, you must specify a subagent_type parameter to select which agent type to use.\n\nWhen NOT to use the Task tool:\n- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly\n- If you are searching for a specific class definition like \"class Foo\", use the Grep tool instead, to find the match more quickly\n- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly\n- If no available agent is a good fit for the task, use other tools directly\n\n\nUsage notes:\n1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses\n2. Once you have delegated work to an agent, do not duplicate that work yourself. Continue with non-overlapping tasks, or wait for the result. For background tasks, you will be notified automatically when the result is ready.\n3. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result. The output includes a task_id you can reuse later to continue the same subagent session.\n4. Each agent invocation starts with a fresh context unless you provide task_id to resume the same subagent session (which continues with its previous messages and tool outputs). When starting fresh, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.\n5. The agent's outputs should generally be trusted\n6. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent. Tell it how to verify its work if possible (e.g., relevant test commands).\n7. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.\n\nAvailable agent types and the tools they have access to:\n- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions.\n- general: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.",
    "parameters": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "description": {
          "type": "string",
          "description": "A short (3-5 words) description of the task"
        },
        "prompt": {
          "type": "string",
          "description": "The task for the agent to perform"
        },
        "subagent_type": {
          "type": "string",
          "description": "The type of specialized agent to use for this task"
        },
        "task_id": {
          "type": "string",
          "description": "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)"
        },
        "command": {
          "type": "string",
          "description": "The command that triggered this task"
        }
      },
      "required": [
        "description",
        "prompt",
        "subagent_type"
      ]
    }
  },
  "todowrite": {
    "description": "Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.\n\n## When to use\nUse proactively when:\n- The task requires 3+ distinct steps or actions (not just 3 tool calls for a single conceptual step)\n- The work is non-trivial and benefits from planning\n- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list\n- New instructions arrive - capture them as todos\n- You start a task - mark it `in_progress` (only one at a time) before working\n- You finish a task - mark it `completed` and add any follow-ups discovered during the work\n\n## When NOT to use\nSkip when:\n- The work is a single, straightforward task (or <3 trivial steps)\n- The request is purely informational or conversational\n- Tracking adds no organizational value\n\n## States\n- `pending` - not started\n- `in_progress` - actively working (exactly ONE at a time)\n- `completed` - finished successfully\n- `cancelled` - no longer needed\n\n## Rules\n- Update status in real time; don't batch completions\n- Mark `completed` only after the required work is actually done, including any required verification. Never based on intent.\n- Keep exactly one `in_progress` while work remains\n- If blocked or partial, keep it `in_progress` and add a follow-up todo describing the blocker\n- Preserve user-provided commands verbatim (flags, args, order)\n- Items should be specific and actionable; break large work into smaller steps\n\n## Examples\n\nUse it:\n- \"Add a dark mode toggle and run the tests\" -> multi-step feature + explicit verification\n- \"Rename getCwd -> getCurrentWorkingDirectory across the repo\" -> grep reveals 15 occurrences in 8 files\n- \"Implement registration, catalog, cart, checkout\" -> multiple complex features\n\nSkip it:\n- \"How do I print Hello World in Python?\" -> informational\n- \"Add a comment to calculateTotal\" -> single edit\n- \"Run npm install and tell me what happened\" -> one command\n\nWhen in doubt, use it.\n",
    "parameters": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "todos": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "content": {
                "type": "string",
                "description": "Brief description of the task"
              },
              "status": {
                "type": "string",
                "description": "Current status of the task: pending, in_progress, completed, cancelled"
              },
              "priority": {
                "type": "string",
                "description": "Priority level of the task: high, medium, low"
              }
            },
            "required": [
              "content",
              "status",
              "priority"
            ]
          },
          "description": "The updated todo list"
        }
      },
      "required": [
        "todos"
      ]
    }
  },
  "webfetch": {
    "description": "- Fetches content from a specified URL\n- Takes a URL and optional format as input\n- Fetches the URL content, converts to requested format (markdown by default)\n- Returns the content in the specified format\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: if another tool is present that offers better web fetching capabilities, is more targeted to the task, or has fewer restrictions, prefer using that tool instead of this one.\n  - The URL must be a fully-formed valid URL\n  - HTTP URLs will be automatically upgraded to HTTPS\n  - Format options: \"markdown\" (default), \"text\", or \"html\"\n  - This tool is read-only and does not modify any files\n  - Results may be summarized if the content is very large\n",
    "parameters": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "The URL to fetch content from"
        },
        "format": {
          "type": "string",
          "enum": [
            "text",
            "markdown",
            "html"
          ],
          "description": "The format to return the content in (text, markdown, or html). Defaults to markdown.",
          "default": "markdown"
        },
        "timeout": {
          "type": "number",
          "description": "Optional timeout in seconds (max 120)"
        }
      },
      "required": [
        "url"
      ]
    }
  },
  "websearch": {
    "description": "- Search the web using the session's web search provider - performs real-time web searches and can scrape content from specific URLs\n- Provides up-to-date information for current events and recent data\n- Supports configurable result counts and returns the content from the most relevant websites\n- Use this tool for accessing information beyond knowledge cutoff\n- Searches are performed automatically within a single API call\n\nUsage notes:\n  - Supports live crawling modes when available: 'fallback' (backup if cached unavailable) or 'preferred' (prioritize live crawling)\n  - Search types when available: 'auto' (balanced), 'fast' (quick results), 'deep' (comprehensive search)\n  - Configurable context length for optimal LLM integration\n  - Domain filtering and advanced search options available\n\nThe current year is 2026. You MUST use this year when searching for recent information or current events\n- Example: If the current year is 2026 and the user asks for \"latest AI news\", search for \"AI news 2026\", NOT \"AI news 2025\"\n",
    "parameters": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Websearch query"
        },
        "numResults": {
          "type": "number",
          "description": "Number of search results to return (default: 8)"
        },
        "livecrawl": {
          "type": "string",
          "enum": [
            "fallback",
            "preferred"
          ],
          "description": "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')"
        },
        "type": {
          "type": "string",
          "enum": [
            "auto",
            "fast",
            "deep"
          ],
          "description": "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search"
        },
        "contextMaxCharacters": {
          "type": "number",
          "description": "Maximum characters for context string optimized for LLMs (default: 10000)"
        }
      },
      "required": [
        "query"
      ]
    }
  },
  "write": {
    "description": "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.\n",
    "parameters": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "content": {
          "type": "string",
          "description": "The content to write to the file"
        },
        "filePath": {
          "type": "string",
          "description": "The absolute path to the file to write (must be absolute, not relative)"
        }
      },
      "required": [
        "content",
        "filePath"
      ]
    }
  }
};
const FP_NAMES = Object.keys(FP_DEFS);

// The free tier rejects requests with more than 33 non-OpenCode tools (even
// with the fingerprint tools present) using a misleading FreeUsageLimitError.
// This is the verified-safe 33-tool core for a large caller: the first OpenCode
// tool set plus the caller's write/web/todo equivalents. Remaining caller tools
// are dropped; fingerprint-only tools are appended as decoys and noted as
// unavailable. Clients with 33 or fewer tools pass through untouched.
const MAX_CLIENT_TOOLS = 33;
const SAFE_CLIENT_TOOLS = [
  "ask_user_question", "create_goal", "create_worktree", "edit", "get_goal",
  "glob", "grep", "interrupt_agent", "job_kill", "job_list", "job_output",
  "list_agents", "load_workspace_dependencies",
  "present", "pwsh", "read", "read_image", "schedule_create", "schedule_edit",
  "send_message", "session_event_read", "session_event_search",
  "session_event_trace", "session_search", "session_trace", "skill",
  "spawn_teammate", "subagent", "subagent_fork", "write", "web_fetch", "web_search", "todo_write",
];

// Hermes/desktop agents use a different tool vocabulary. This verified-safe
// 33-tool core keeps file, shell, web, delegation, skill-view, project, UI,
// browser, and code-execution tools. MCP setup, skill management/listing, and
// TTS are excluded because adding them together re-triggers the free-tier 429.
const HERMES_SAFE_TOOLS = [
  "read_file", "write_file", "patch", "search_files", "terminal", "process",
  "web_search", "web_extract", "todo", "session_search", "delegate_task",
  "memory", "skill_view", "clarify", "cronjob",
  "project_create", "project_list", "project_switch",
  "annotate_preview", "apply_layout", "close_preview", "close_terminal",
  "drive_preview", "focus_pane", "open_preview", "read_preview",
  "read_terminal", "read_window_below", "browser_exec", "computer_use",
  "execute_code", "tour", "vision_analyze",
];
const HERMES_UNSAFE_TOOLS = new Set(["setup_mcp", "skill_manage", "skills_list", "text_to_speech"]);

// OpenClaw 2026.x uses a much larger tool vocabulary (exec/apply_patch/
// sessions_*/subagents, etc.). Its default set is ~70 tools, so it must be
// reduced before the 11 OpenCode fingerprint decoys are appended. This is the
// coding-agent core; media/plugin/gateway-only tools are intentionally left
// out because broad 33-tool selections still trigger the fake 429.
const OPENCLAW_SAFE_TOOLS = [
  "ls", "read", "write", "edit", "apply_patch",
  "exec", "process", "code_execution",
  "web_search", "web_fetch", "x_search",
  "memory_search", "memory_get",
  "sessions", "sessions_list", "sessions_history", "sessions_search",
  "sessions_send", "sessions_spawn", "sessions_yield", "subagents",
  "session_status", "agents_list", "agents_wait",
  "browser", "terminal", "message", "automations",
  "get_goal", "create_goal", "update_goal",
  "view_image", "ask_user",
];

const GLOBAL_UNSAFE_TOOLS = new Set();

const ANOMALY_TOOL_ALIASES = new Map([
  ["sessions_spawn", "spawn_agent"],
  ["subagent_fork", "fork_agent"],
  ["ReportFindings", "report_findings"],
  ["write_stdin", "stdin"],
]);

/* ---------- session / request ids ---------- */
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function randB62(n) {
  const b = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += B62[b[i] % 62];
  return s;
}

// Session prefix = 12 hex of ~(timeMs*0x1000+counter), low 48 bits, like the CLI.
// Upstream decodes it and rejects a non-small counter with 403, so the counter
// must stay small (0-16 pass, >=100 fail).
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
let lastTs = 0;
let counter = 0;
function descendingTimeHex(time, c) {
  return (~(BigInt(time) * 0x1000n + BigInt(c)) & SESSION_PREFIX_MASK).toString(16).padStart(12, "0");
}
function newSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTs) {
    lastTs = timestamp;
    counter = 0;
  }
  counter++;
  return `ses_${descendingTimeHex(timestamp, counter)}${randB62(14)}`;
}
function newMessageId(timestamp = Date.now()) {
  return `msg_${descendingTimeHex(timestamp, 1)}${randB62(14)}`;
}
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
// Reuse a conforming incoming session (preserves upstream quota); otherwise
// derive a valid one deterministically so the counter stays small.
function resolveSession(incoming) {
  const s = String(incoming || "").trim();
  if (SESSION_RE.test(s)) return s;
  if (s) {
    const digest = crypto.createHash("sha256").update(`opencode\0${s}`).digest();
    const time = BigInt(`0x${digest.subarray(0, 5).toString("hex")}`) & ((1n << 36n) - 1n);
    const timeHex = descendingTimeHex(time, 1);
    let rand = "";
    for (let i = 6; i < 20; i++) rand += B62[digest[i] % 62];
    return `ses_${timeHex}${rand}`;
  }
  return newSessionId();
}

/* ---------- model helpers ---------- */
/** Strip "oc/" alias prefix and "(max)" thinking suffix. */
function baseModel(id) {
  return String(id || "")
    .replace(/^oc\//i, "")
    .replace(/\([^()]+\)\s*$/i, "")
    .trim();
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((p) => p && (p.type === "text" || p.type === "input_text" || p.type === "output_text") && p.text)
      .map((p) => p.text)
      .join("");
  return "";
}

/** Map OpenAI chat messages -> Responses `input` items. */
function messagesToInput(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system" || m.role === "developer") {
      const t = textOf(m.content);
      if (t) out.push({ type: "message", role: m.role, content: [{ type: "input_text", text: t }] });
    } else if (m.role === "user") {
      if (typeof m.content === "string") {
        if (m.content) out.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content }] });
      } else if (Array.isArray(m.content)) {
        const parts = [];
        for (const p of m.content) {
          if (!p || typeof p !== "object") continue;
          if ((p.type === "text" || p.type === "input_text") && p.text) parts.push({ type: "input_text", text: p.text });
          else if (p.type === "image_url" && (p.image_url?.url || p.image_url)) {
            const u = typeof p.image_url === "string" ? p.image_url : p.image_url.url || p.image_url;
            parts.push({ type: "input_image", image_url: u });
          }
        }
        if (parts.length) out.push({ type: "message", role: "user", content: parts });
      }
    } else if (m.role === "assistant") {
      const t = textOf(m.content);
      if (t) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: t }] });
      for (const tc of m.tool_calls || []) {
        const fn = tc.function || {};
        if (!fn.name) continue;
        out.push({
          type: "function_call",
          name: fn.name,
          call_id: tc.id || `call_${randB62(12)}`,
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
    } else if (m.role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: m.tool_call_id || m.call_id || `call_${randB62(12)}`,
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
    }
  }
  return out;
}

/** Normalize OpenAI/Responses tool defs -> a given shape. */
function normalizeTools(tools, flat) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object" || Array.isArray(t)) continue;
    const fn = t.function && typeof t.function === "object" && !Array.isArray(t.function) ? t.function : null;
    const name =
      (typeof t.name === "string" && t.name.trim() ? t.name.trim() : "") ||
      (fn && typeof fn.name === "string" ? fn.name.trim() : "");
    if (!name) continue;
    const desc =
      (typeof t.description === "string" && t.description ? t.description : "") ||
      (fn && typeof fn.description === "string" ? fn.description : "");
    let params =
      t.parameters && typeof t.parameters === "object" && !Array.isArray(t.parameters)
        ? t.parameters
        : fn && fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
          ? fn.parameters
          : { type: "object", properties: {} };
    if (params.type !== "object" || !params.properties) params = { ...params, type: "object", properties: params.properties || {} };
    const name2 = name.slice(0, 128);
    out.push(
      flat
        ? { type: "function", name: name2, ...(desc ? { description: desc } : {}), parameters: params }
        : { type: "function", function: { name: name2, ...(desc ? { description: desc } : {}), parameters: params } }
    );
  }
  return out;
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && typeof fn.name === "string" && fn.name.trim()) return fn.name.trim();
  return "";
}
function chatFunctionOf(tool) {
  const fn = tool && tool.function;
  return fn && typeof fn === "object" && !Array.isArray(fn) ? fn : null;
}
function isFingerprintDef(tool, key) {
  const def = chatFunctionOf(tool) || tool;
  const want = FP_DEFS[key];
  return !!def && def.description === want.description && JSON.stringify(def.parameters) === JSON.stringify(want.parameters);
}
function withToolName(tool, name) {
  const fn = chatFunctionOf(tool);
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

// Move caller tools off the fingerprint names when their definition differs, so
// the exact fingerprint definitions can be appended without a duplicate name.
function concealFingerprintNames(tools) {
  const map = new Map();
  if (!Array.isArray(tools) || !tools.length) return { tools, map };
  const taken = new Set(tools.map(toolNameOf));
  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }
    const key = FP_NAMES.includes(toolNameOf(tool)) ? toolNameOf(tool) : "";
    if (!key) {
      out.push(tool);
      continue;
    }
    if (seen.has(key)) continue; // upstream rejects duplicate names; keep first
    seen.add(key);
    if (isFingerprintDef(tool, key)) {
      out.push(tool);
      continue;
    }
    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
    taken.add(alias);
    map.set(alias, key);
    out.push(withToolName(tool, alias));
  }
  return { tools: out, map };
}

function concealAnomalyNames(tools) {
  const map = new Map();
  if (!Array.isArray(tools) || !tools.length) return { tools, map };
  const taken = new Set(tools.map(toolNameOf));
  const out = tools.map((tool) => {
    const name = toolNameOf(tool);
    if (!ANOMALY_TOOL_ALIASES.has(name)) return tool;
    let alias = ANOMALY_TOOL_ALIASES.get(name);
    for (let i = 2; taken.has(alias); i++) alias = `${ANOMALY_TOOL_ALIASES.get(name)}${i}`;
    taken.add(alias);
    map.set(alias, name);
    return withToolName(tool, alias);
  });
  return { tools: out, map };
}

function appendFingerprintTools(tools, flat) {
  const appended = [];
  for (const name of FP_NAMES) {
    if (tools.some((t) => toolNameOf(t) === name)) continue;
    const { description, parameters } = FP_DEFS[name];
    tools.push(
      flat
        ? { type: "function", name, description, parameters, strict: false }
        : { type: "function", function: { name, description, parameters } }
    );
    appended.push(name);
  }
  return appended;
}

function toolNameSet(tools) {
  const names = new Set();
  for (const tool of tools) {
    const name = toolNameOf(tool).toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

function isHermesToolset(tools) {
  const names = toolNameSet(tools);
  return names.has("read_file") && names.has("search_files") && names.has("terminal") && !names.has("bash");
}

function isOpenClawToolset(tools) {
  const names = toolNameSet(tools);
  return names.has("exec") && (names.has("apply_patch") || names.has("sessions_spawn") || names.has("subagents") || names.has("view_image"));
}

function resolveToolProfile(tools) {
  if (isHermesToolset(tools)) {
    return { name: "hermes", priority: HERMES_SAFE_TOOLS, blocked: HERMES_UNSAFE_TOOLS, strict: true };
  }
  if (isOpenClawToolset(tools)) {
    return { name: "openclaw", priority: OPENCLAW_SAFE_TOOLS, blocked: GLOBAL_UNSAFE_TOOLS, strict: true };
  }
  return { name: "opencode", priority: SAFE_CLIENT_TOOLS, blocked: GLOBAL_UNSAFE_TOOLS, strict: false };
}

function capClientTools(tools, max = MAX_CLIENT_TOOLS) {
  if (!Array.isArray(tools) || !tools.length) return { tools: [], dropped: [], profile: "none" };

  const profile = resolveToolProfile(tools);
  const byKey = new Map();
  for (const tool of tools) {
    const name = toolNameOf(tool);
    const key = name.toLowerCase();
    if (key && !byKey.has(key)) byKey.set(key, { name, tool });
  }
  const hasBlocked = [...byKey.keys()].some((key) => profile.blocked.has(key));
  // DSH sends working_directory + read_image together; that pair triggers the
  // fake 429 even with only four tools. Keep working_directory and drop the
  // image reader, which no coding harness needs for text-only tasks.
  const hasWorkingDirectory = byKey.has("working_directory");
  const pairDrop = hasWorkingDirectory && byKey.has("read_image");
  const blocked = pairDrop ? new Set([...profile.blocked, "read_image"]) : profile.blocked;

  // Preserve native small toolsets (OpenCode/Claude Code) byte-for-byte, but
  // always filter OpenClaw to its verified-safe vocabulary: 2026.11.3 sends a
  // 14-tool mix whose unknown meta tools trigger the fake 429 even under 33.
  if (tools.length <= max && !hasBlocked && !pairDrop && profile.name !== "openclaw") {
    return { tools, dropped: [], profile: profile.name };
  }

  const keep = new Set();
  for (const name of profile.priority) {
    if (keep.size >= max) break;
    const key = name.toLowerCase();
    if (byKey.has(key) && !blocked.has(key)) keep.add(key);
  }

  // Unknown harnesses may have a different vocabulary. Fill spare slots only
  // with caller tools that are not known-bad; recognized profiles stay strict
  // so an anomaly tool can never sneak back in just to reach 33.
  if (!profile.strict && keep.size < max) {
    for (const key of byKey.keys()) {
      if (keep.has(key) || blocked.has(key)) continue;
      keep.add(key);
      if (keep.size >= max) break;
    }
  }

  const out = [];
  const seen = new Set();
  for (const tool of tools) {
    const name = toolNameOf(tool);
    const key = name.toLowerCase();
    if (!key || !keep.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(tool);
  }
  const dropped = [...byKey.entries()].filter(([key]) => !keep.has(key)).map(([, v]) => v.name);
  return { tools: out, dropped, profile: profile.name };
}

function retargetToolChoice(body, map) {
  if (!body || !map.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  const aliases = new Map([...map].map(([alias, orig]) => [orig, alias]));
  if (typeof choice.name === "string") {
    const alias = aliases.get(choice.name.trim());
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }
  const fn = choice.function;
  if (fn && typeof fn === "object" && typeof fn.name === "string") {
    const alias = aliases.get(fn.name.trim());
    if (alias) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
  }
}

function aliasHistoryToolCalls(body, map) {
  if (!body || !map.size) return;
  const aliases = new Map([...map].map(([alias, orig]) => [orig, alias]));
  if (Array.isArray(body.input)) {
    body.input = body.input.map((it) =>
      it && it.type === "function_call" && aliases.has(it.name) ? { ...it, name: aliases.get(it.name) } : it
    );
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((m) => {
      if (!Array.isArray(m?.tool_calls)) return m;
      return {
        ...m,
        tool_calls: m.tool_calls.map((c) =>
          c && c.function && aliases.has(c.function.name)
            ? { ...c, function: { ...c.function, name: aliases.get(c.function.name) } }
            : c
        ),
      };
    });
  }
}

// Tell the model the appended fingerprint tools are placeholders (without this
// the model actually calls them).
function noteUnavailable(body, flat, names) {
  const list = names.map((n) => `\`${n}\``).join(" or ");
  const note =
    names.length > 1
      ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
      : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
  if (flat) {
    body.instructions = typeof body.instructions === "string" && body.instructions.trim() ? `${body.instructions}\n\n${note}` : note;
    return;
  }
  if (!Array.isArray(body.messages)) return;
  const first = body.messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)];
  } else {
    body.messages = [{ role: "system", content: note }, ...body.messages];
  }
}

/** Full fingerprint pass: alias conflicting caller tools, append read/shell,
 * retarget tool_choice, alias history, note placeholders. Returns rename map. */
function applyFingerprint(body, flat) {
  if (!body || typeof body !== "object") return new Map();
  const capped = capClientTools(body.tools);
  const fp = concealFingerprintNames(capped.tools);
  const anomaly = concealAnomalyNames(fp.tools);
  const map = new Map([...fp.map, ...anomaly.map]);
  body.tools = Array.isArray(anomaly.tools) ? anomaly.tools : [];
  const appended = appendFingerprintTools(body.tools, flat);
  retargetToolChoice(body, map);
  aliasHistoryToolCalls(body, map);
  if (appended.length) noteUnavailable(body, flat, appended);
  dropInvalidObjectChoice(body);
  // Responses: never default tool_choice to "none" (upstream 403s it).
  if (!body.tool_choice && flat) body.tool_choice = "auto";
  return map;
}

// Zen reasoning models reject multi-turn history whose assistant messages carry
// no reasoning_content; inject a placeholder (9router reasoningInject scope=all).
function injectReasoning(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  body.messages = body.messages.map((m) =>
    m && m.role === "assistant" && !(typeof m.reasoning_content === "string" && m.reasoning_content)
      ? { ...m, reasoning_content: " " }
      : m
  );
  return body;
}

function messageText(message) {
  const content = message && message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part && typeof part.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}

// The shim must describe the client workspace, not the proxy's cwd. The
// upstream model trusts this block when choosing absolute paths.
function detectWorkingDir(chatBody) {
  const texts = [];
  if (Array.isArray(chatBody.messages)) {
    for (const message of chatBody.messages) {
      if (message && (message.role === "system" || message.role === "developer")) texts.push(messageText(message));
    }
  }
  if (typeof chatBody.instructions === "string") texts.push(chatBody.instructions);
  if (Array.isArray(chatBody.input)) {
    for (const item of chatBody.input) {
      if (item && (item.role === "system" || item.role === "developer")) texts.push(messageText(item));
    }
  }
  const patterns = [
    /(?:^|\n)\s*Working directory:\s*([^\n<]+)/i,
    /(?:^|\n)\s*Your working directory is:\s*([^\n<]+)/i,
    /(?:^|\n)\s*Current working directory:\s*([^\n<]+)/i,
    /(?:^|\n)\s*Workspace root folder:\s*([^\n<]+)/i,
    /(?:^|\n)\s*cwd:\s*([^\n<]+)/i,
  ];
  for (const text of texts) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      const candidate = match[1].trim().replace(/^[`"']+|[`"']+$/g, "").split(/\s+/)[0];
      if (!candidate.startsWith("/")) continue;
      if (candidate.includes("${") || candidate.includes("<")) continue;
      return candidate;
    }
  }
  return process.cwd();
}

// OpenCode normally injects this <env> block; the proxy adds it as inert
// environment metadata for fingerprint fidelity. It is not sufficient alone.
function gateEnvMessage(cwd = process.cwd()) {
  return `<env>
  Working directory: ${cwd}
  Workspace root folder: ${path.parse(cwd).root || "/"}
  Is directory a git repo: ${fs.existsSync(path.join(cwd, ".git")) ? "yes" : "no"}
  Platform: ${process.platform}
  Today's date: ${new Date().toDateString()}
</env>`;
}

/** Build upstream body. Returns { body, map } (map: sent tool name -> original). */
function buildUpstreamBody(chatBody) {
  const model = baseModel(chatBody.model);
  const cwd = detectWorkingDir(chatBody);
  if (isResponsesModel(model)) {
    const body = { model, stream: true, store: false, instructions: gateEnvMessage(cwd) };
    let input = Array.isArray(chatBody.input) ? chatBody.input : messagesToInput(chatBody.messages);
    if (!input.length) input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    body.input = input;
    if (chatBody.max_output_tokens !== undefined) body.max_output_tokens = chatBody.max_output_tokens;
    else if (chatBody.max_completion_tokens !== undefined) body.max_output_tokens = chatBody.max_completion_tokens;
    else if (chatBody.max_tokens !== undefined) body.max_output_tokens = chatBody.max_tokens;
    for (const k of ["temperature", "top_p", "reasoning", "reasoning_effort"]) {
      if (chatBody[k] !== undefined) body[k] = chatBody[k];
    }
    if (body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning) && !body.reasoning.summary) {
      body.reasoning = { ...body.reasoning, summary: "auto" };
    }
    body.tools = normalizeTools(chatBody.tools, true);
    if (chatBody.tool_choice !== undefined) body.tool_choice = chatBody.tool_choice;
    dropInvalidObjectChoice(body);
    if ("tool_choice" in body && body.tool_choice !== "auto") body.tool_choice = "auto";
    const map = applyFingerprint(body, true);
    return { body, map };
  }

  // Chat lane: pass messages through in OpenAI shape.
  const body = { model, stream: true };
  body.messages = Array.isArray(chatBody.messages) ? chatBody.messages.slice() : [];
  for (const k of ["temperature", "top_p", "max_tokens", "max_completion_tokens", "tool_choice"]) {
    if (chatBody[k] !== undefined) body[k] = chatBody[k];
  }
  body.tools = normalizeTools(chatBody.tools, false);
  dropInvalidObjectChoice(body);
  if ("tool_choice" in body && body.tool_choice !== "auto") body.tool_choice = "auto";
  const map = applyFingerprint(body, false);
  body.messages = [{ role: "system", content: gateEnvMessage(cwd) }, ...body.messages];
  body.stream_options = {
    ...(chatBody.stream_options && typeof chatBody.stream_options === "object" ? chatBody.stream_options : {}),
    include_usage: true,
  };
  injectReasoning(body);
  return { body, map };
}

function dropInvalidObjectChoice(body) {
  if (!body.tool_choice || typeof body.tool_choice !== "object" || Array.isArray(body.tool_choice)) return;
  if (body.tool_choice.type !== "function") return;
  const names = new Set((body.tools || []).map(toolNameOf));
  const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
  if (!n || !names.has(n)) delete body.tool_choice;
}

function buildHeaders({ sessionId, userAgent, requestId } = {}) {
  const s = resolveSession(sessionId);
  const incoming = String(userAgent || "");
  const ua = /^opencode\/\d+\./i.test(incoming) && incoming.includes("runtime/") ? incoming : CLIENT_UA;
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer public",
    "User-Agent": ua,
    "x-opencode-client": CLIENT_NAME,
    "x-opencode-request": requestId || newMessageId(),
    "x-opencode-session": s,
    "x-opencode-session-id": s,
    "x-opencode-project": "global",
    Accept: "*/*",
  };
}

function upstreamUrl(model) {
  return isResponsesModel(model)
    ? `${UPSTREAM_BASE}/inference/v1/responses`
    : `${UPSTREAM_BASE}/inference/openai/v1/chat/completions`;
}

/* ---------- SSE framing ---------- */
function splitFrames(buffer) {
  const frames = [];
  let start = 0;
  while (true) {
    const i = buffer.indexOf("\n\n", start);
    if (i === -1) break;
    frames.push(buffer.slice(start, i));
    start = i + 2;
  }
  return { frames, rest: buffer.slice(start) };
}
function parseFrame(raw) {
  let event = null;
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  const dataRaw = dataLines.join("\n");
  if (dataRaw === "[DONE]") return { event: "done", data: null };
  try {
    return { event, data: JSON.parse(dataRaw) };
  } catch {
    return null;
  }
}

/* ---------- shared translator scaffold ---------- */
function makeState(openaiModel) {
  return { text: "", tools: new Map(), order: [], usage: null, respModel: openaiModel, cutoff: false, toolsDone: false, upstreamFinish: null };
}
function toolSlot(state, key) {
  if (!state.tools.has(key)) {
    const slot = { key, index: state.order.length, id: null, name: null, args: "", sent: 0, nameEmitted: false };
    state.tools.set(key, slot);
    state.order.push(key);
  }
  return state.tools.get(key);
}
function restoreName(map, name) {
  if (map && map.size && typeof name === "string" && map.has(name)) return map.get(name);
  return name;
}
function finishReasonFor(state) {
  if (state.cutoff && !state.toolsDone) return "length";
  if (state.upstreamFinish) return state.upstreamFinish;
  return state.order.length ? "tool_calls" : "stop";
}
function mkChunk(state, id, created, delta, finish, extra) {
  const c = {
    id,
    object: "chat.completion.chunk",
    created,
    model: state.respModel,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (extra) Object.assign(c, extra);
  return `data: ${JSON.stringify(c)}\n\n`;
}
function usageOf(u) {
  return {
    prompt_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.prompt_tokens ?? u.input_tokens ?? 0) + (u.completion_tokens ?? u.output_tokens ?? 0),
  };
}
function finalJsonOf(state, id, created, renameMap) {
  const tools = state.order.map((k) => state.tools.get(k));
  const message = { role: "assistant", content: state.text };
  if (tools.length) {
    message.tool_calls = tools.map((s) => ({
      id: s.id || `call_${randB62(12)}`,
      type: "function",
      function: { name: restoreName(renameMap, s.name || ""), arguments: s.args },
    }));
  }
  return {
    id,
    object: "chat.completion",
    created,
    model: state.respModel,
    choices: [{ index: 0, message, finish_reason: finishReasonFor(state) }],
    usage: state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/* ---------- Responses lane translator (muse-spark) ---------- */
function createTranslator(openaiModel, renameMap) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${randB62(12)}${Date.now().toString(36)}`;
  const state = makeState(openaiModel);

  function toolChunk(s, piece) {
    const fn = {};
    if (s.name && !s.nameEmitted) {
      fn.name = restoreName(renameMap, s.name);
      s.nameEmitted = true;
    }
    if (piece) fn.arguments = piece;
    const tc = { index: s.index, type: "function", function: fn };
    if (s.id && (!s.idEmitted || fn.name)) {
      tc.id = s.id;
      s.idEmitted = true;
    }
    return mkChunk(state, id, created, { tool_calls: [tc] }, null);
  }

  function apply(type, d) {
    const out = [];
    if (!d || typeof d !== "object") return out;
    if (type === "response.created" && d.response) {
      if (d.response.model) state.respModel = d.response.model;
      out.push(mkChunk(state, id, created, { role: "assistant" }, null));
    } else if (type === "response.output_item.added" && d.item) {
      const it = d.item;
      if (it.type === "function_call") {
        const s = toolSlot(state, String(d.output_index ?? it.call_id ?? it.id ?? state.order.length));
        if (it.call_id || it.id) s.id = it.call_id || it.id;
        if (it.name) s.name = it.name;
        if (it.arguments && !s.args) s.args = typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments);
      }
    } else if (type === "response.function_call_arguments.delta") {
      const s = toolSlot(state, String(d.output_index ?? d.item_id ?? state.order.length));
      if (d.item_id && !s.id) s.id = d.item_id;
      const piece = typeof d.delta === "string" ? d.delta : "";
      s.args += piece;
      s.sent += piece.length;
      out.push(toolChunk(s, piece));
    } else if (type === "response.output_text.delta") {
      const piece = typeof d.delta === "string" ? d.delta : "";
      state.text += piece;
      out.push(mkChunk(state, id, created, { content: piece }, null));
    } else if (type === "response.output_item.done" && d.item) {
      const it = d.item;
      if (it.type === "function_call") {
        const s = toolSlot(state, String(d.output_index ?? it.call_id ?? it.id ?? state.order.length));
        if (it.call_id || it.id) s.id = it.call_id || it.id;
        if (it.name) s.name = it.name;
        s.done = true;
        state.toolsDone = true;
        const full = typeof it.arguments === "string" ? it.arguments : it.arguments ? JSON.stringify(it.arguments) : "";
        if (full && full.length >= s.args.length) {
          const rest = full.slice(s.sent);
          s.args = full;
          s.sent = full.length;
          if ((!s.nameEmitted && s.name) || rest) out.push(toolChunk(s, rest));
        } else if (s.name && !s.nameEmitted) {
          out.push(toolChunk(s, ""));
        }
      } else if (it.type === "message" && !state.text) {
        const t = Array.isArray(it.content)
          ? it.content.filter((p) => p.type === "output_text" && p.text).map((p) => p.text).join("")
          : "";
        if (t) {
          state.text = t;
          out.push(mkChunk(state, id, created, { content: t }, null));
        }
      }
    } else if (type === "response.output_text.done" && typeof d.text === "string") {
      if (!state.text) {
        state.text = d.text;
        out.push(mkChunk(state, id, created, { content: d.text }, null));
      }
    } else if ((type === "response.completed" || type === "response.incomplete") && d.response?.usage) {
      state.usage = usageOf(d.response.usage);
      if (d.response.model) state.respModel = d.response.model;
    } else if (type === "response.failed" || type === "error") {
      const msg = d.error?.message || d.message || "upstream error";
      throw new Error(`upstream: ${msg}`);
    }
    return out;
  }

  return {
    state,
    apply,
    markCutoff: () => (state.cutoff = true),
    finish: () => finishReasonFor(state),
    finalChunk: () => mkChunk(state, id, created, {}, finishReasonFor(state), state.usage ? { usage: state.usage } : null),
    finalJson: () => finalJsonOf(state, id, created, renameMap),
  };
}

/* ---------- Chat lane relay (other free models): upstream is already OpenAI ---------- */
function createChatRelay(openaiModel, renameMap) {
  const created = Math.floor(Date.now() / 1000);
  let id = `chatcmpl-${randB62(12)}${Date.now().toString(36)}`;
  const state = makeState(openaiModel);

  function apply(type, d) {
    const out = [];
    if (!d || typeof d !== "object") return out;
    if (typeof d.id === "string" && d.id) id = d.id;
    if (d.model) state.respModel = d.model;
    const ch = Array.isArray(d.choices) ? d.choices[0] : null;
    const delta = ch && ch.delta;
    if (delta) {
      if (typeof delta.content === "string" && delta.content) state.text += delta.content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const s = toolSlot(state, String(tc.index ?? state.order.length));
          if (tc.id) s.id = tc.id;
          if (tc.function?.name) {
            s.name = tc.function.name;
            s.nameEmitted = true;
          }
          if (typeof tc.function?.arguments === "string") s.args += tc.function.arguments;
        }
      }
    }
    if (ch && typeof ch.finish_reason === "string" && ch.finish_reason) {
      state.upstreamFinish = ch.finish_reason;
      state.toolsDone = true;
    }
    if (d.usage) state.usage = usageOf(d.usage);

    // Relay the chunk, but strip finish_reason (we emit our own final) and
    // restore any aliased tool names so the client sees its own tool.
    const relay = { ...d };
    if (Array.isArray(relay.choices)) {
      relay.choices = relay.choices.map((c) => {
        const next = { ...c, finish_reason: null };
        if (c.delta && Array.isArray(c.delta.tool_calls)) {
          next.delta = {
            ...c.delta,
            tool_calls: c.delta.tool_calls.map((tc) =>
              tc.function && tc.function.name
                ? { ...tc, function: { ...tc.function, name: restoreName(renameMap, tc.function.name) } }
                : tc
            ),
          };
        }
        return next;
      });
    }
    out.push(`data: ${JSON.stringify(relay)}\n\n`);
    return out;
  }

  return {
    state,
    apply,
    markCutoff: () => (state.cutoff = true),
    finish: () => finishReasonFor(state),
    finalChunk: () => mkChunk(state, id, created, {}, finishReasonFor(state), state.usage ? { usage: state.usage } : null),
    finalJson: () => finalJsonOf(state, id, created, renameMap),
  };
}

function makeTranslator(model, renameMap) {
  return isResponsesModel(model) ? createTranslator(model, renameMap) : createChatRelay(model, renameMap);
}

/* ---------- gateway helpers ---------- */
function checkAuth(req) {
  const need = (process.env.GATEWAY_API_KEY || "").trim();
  if (!need) return true;
  const got = String(req.headers.authorization || req.headers.Authorization || "");
  const keys = need.split(",").map((s) => s.trim()).filter(Boolean);
  return keys.some((k) => got === `Bearer ${k}`);
}
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

// Shape/size summary for request logs. Never includes message text.
function summarizeBody(body) {
  const msgs = Array.isArray(body?.messages)
    ? body.messages
    : (Array.isArray(body?.input) ? body.input : []);
  const roles = {};
  let systemChars = 0;
  let toolResultChars = 0;
  let maxMessageChars = 0;
  let images = 0;
  for (const m of msgs) {
    const role = m?.role || m?.type || "?";
    roles[role] = (roles[role] || 0) + 1;
    let s = "";
    try { s = JSON.stringify(m); } catch { s = ""; }
    if (s.length > maxMessageChars) maxMessageChars = s.length;
    if (role === "system") systemChars += s.length;
    if (role === "tool" || role === "function_call_output") toolResultChars += s.length;
    const content = m?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && (part.type === "image_url" || part.type === "input_image" || part.image_url)) images++;
      }
    }
  }
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  let bytes = 0;
  try { bytes = JSON.stringify(body).length; } catch {}
  return {
    model: body?.model,
    stream: body?.stream,
    max_tokens: body?.max_tokens,
    inputItems: msgs.length,
    roles,
    tools: tools.length,
    toolNames: tools.map((t) => t?.function?.name || t?.name).filter(Boolean).slice(0, 100),
    bytes,
    systemChars,
    toolResultChars,
    maxMessageChars,
    images,
    topLevelKeys: Object.keys(body || {}),
  };
}

module.exports = {
  UPSTREAM_BASE,
  FP_DEFS,
  baseModel,
  isAllowedModel,
  isResponsesModel,
  messagesToInput,
  normalizeTools,
  isHermesToolset,
  isOpenClawToolset,
  resolveToolProfile,
  capClientTools,
  OPENCLAW_SAFE_TOOLS,
  HERMES_SAFE_TOOLS,
  SAFE_CLIENT_TOOLS,
  applyFingerprint,
  buildUpstreamBody,
  buildHeaders,
  upstreamUrl,
  newSessionId,
  resolveSession,
  splitFrames,
  parseFrame,
  createTranslator,
  createChatRelay,
  makeTranslator,
  checkAuth,
  cors,
  summarizeBody,
};
