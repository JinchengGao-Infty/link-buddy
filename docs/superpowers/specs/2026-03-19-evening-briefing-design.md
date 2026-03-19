# Evening Briefing Design

## Overview

Add an evening briefing cron job with a bundled Hacker News skill. The evening briefing complements the morning briefing: morning looks forward, evening looks backward and includes tech news.

## Bundled Hacker News Skill

**File:** `skills/bundled/hacker-news.mjs`

Fetches top 20 stories from the public HN Firebase API:
1. `GET https://hacker-news.firebaseio.com/v0/topstories.json` → array of story IDs
2. Take first 20 IDs, fetch each: `GET https://hacker-news.firebaseio.com/v0/item/{id}.json`
3. Return formatted text list with: title, URL, score, comment count, author

**Input:** none required (always top 20)
**Output:** formatted text list the agent can summarize and pick recommendations from

**Registration:** Add to `skills/registry.yaml` as a bundled skill so it's available via the MCP server as `skill_hacker_news`.

## Evening Briefing Cron Job

**Config:** New entry in `config/local.yaml`

```yaml
evening_briefing:
  cron: "0 23 * * *"    # 11 PM every day, America/Chicago
  prompt: |
    You are delivering an evening briefing to flyingchickens.

    ## Required sections:
    1. **Greeting** — brief, wind-down tone appropriate to end of day.
    2. **Daily wrap-up** — summarize what was accomplished today using memory context and memory tools. Highlight conversations, decisions made, skills created, and any notable interactions.
    3. **Unresolved items** — flag anything from today that was left open: unanswered questions, tasks mentioned but not completed, promises made. If nothing is unresolved, say so briefly.
    4. **Tech news** — use the skill_hacker_news tool to get today's top Hacker News stories. Summarize the key themes and trends. Recommend 2-3 stories worth reading with links.
    5. **System health** — use system_health tool. Only mention if there are failures or degraded modules. If all healthy, skip this section entirely.

    ## Briefing preferences:
    Check the user's profile for any stored briefing preferences. Honor those preferences.

    ## Format:
    Keep it concise — a quick end-of-day summary, not a detailed report. Use short paragraphs.
  user: flyingchickens
```

## Infrastructure

No code changes needed to the scheduler, gateway, or bootstrap. The existing morning briefing infrastructure provides:
- Memory context assembly (user history + profile)
- Retrieval tools (memory_grep, memory_describe, memory_expand)
- System health tool via MCP server
- Skill execution via MCP server
- Proactive messaging to Discord DM
- Timezone-aware cron scheduling (America/Chicago)

## Testing

- Verify skill works manually via Discord ("use the hacker-news skill")
- First evening trigger: 11 PM CST
- Check Discord DM for briefing with daily wrap-up + HN recommendations
