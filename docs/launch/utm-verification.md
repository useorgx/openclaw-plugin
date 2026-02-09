# UTM Link Verification (Tweet Threads + Article)

Date: 2026-02-09

## Verified URLs
- https://useorgx.com/integrations/openclaw?utm_source=x&utm_medium=thread&utm_campaign=openclaw_launch&utm_content=launch_announcement
- https://useorgx.com/integrations/openclaw?utm_source=x&utm_medium=thread&utm_campaign=openclaw_launch&utm_content=value_prop
- https://useorgx.com/integrations/openclaw?utm_source=x&utm_medium=thread&utm_campaign=openclaw_launch&utm_content=build_in_public
- https://useorgx.com/integrations/openclaw?utm_source=x&utm_medium=thread&utm_campaign=openclaw_launch&utm_content=demo_walkthrough
- https://useorgx.com/integrations/openclaw?utm_source=devto&utm_medium=article&utm_campaign=openclaw_launch&utm_content=devto_article
- https://useorgx.com/integrations/openclaw?utm_source=x&utm_medium=thread&utm_campaign=openclaw_launch&utm_content=tame_the_claw
- https://useorgx.com/integrations/openclaw?utm_source=x&utm_medium=thread&utm_campaign=openclaw_launch&utm_content=meet_the_crew
- https://useorgx.com/integrations/openclaw?utm_source=x&utm_medium=thread&utm_campaign=openclaw_launch&utm_content=press_continue
- https://useorgx.com/integrations/openclaw?utm_source=x&utm_medium=ad&utm_campaign=openclaw_launch&utm_content=ad_before_after
- https://useorgx.com/integrations/openclaw?utm_source=x&utm_medium=ad&utm_campaign=openclaw_launch&utm_content=ad_press_continue

## Command
```bash
curl -s -L -o /dev/null -w "%{http_code} %{url_effective}\n" "<url>"
```

## Results
All ten URLs returned HTTP `200` after redirects and preserved UTM query params on the final URL (`https://www.useorgx.com/...`).
