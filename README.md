# Toshy - Coding Agent v0.1
[Rivet][riv]-based coding agent for work in VSCode. \
Is in active development. \
Only for Linux now. Do not supports images for now.

## Tools which agent can use
- **Remember This** - Save something to agent permanent memory.
- **Forget This** - Erase something out of agent permanent memory.
- **Search Memory** - Searching agent temporary and permanent memory.
- **List memories** - List agent permanent memory for user.
- **Lite Web Search** - Parsing short search results straight to agent context.
- **Deep Web Search** - Parsing a couple of web pages to agent temporary memory.
- **Read URL** - Parsing web page under link to agent temporary memory.
- **@File ("Continue" - User usage only)** - Get code from the specified project file.

## Dependencies
- VSCode + Continue (2.0.0)
- Node.js (v18+)
- (Optional) [Rivet][riv]

## Installation
```bash
git clone https://github.com/supertoshibaz/toshy
cd toshy
npm install
```

Copy config.yaml contents to your config.yaml ("Continue")

## Using
Start main model at 0.0.0.0:8080 \
Start embedding model at 0.0.0.0:8081 \
Start server.js (node ./server.js) \
You can talk with agent in "Continue" chat. Also you can use Ctrl+I to redact parts of code in your project.

[riv]:https://github.com/Ironclad/rivet
