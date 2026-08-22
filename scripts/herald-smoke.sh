#!/usr/bin/env bash
# Herald P5 smoke — exercises the S9/S15 surface against a running server.
#
# Usage:
#   BASE_URL=http://localhost:3000 LXK_API_KEY=<key> ./scripts/herald-smoke.sh
#
# Boots a mock OpenAI-compatible provider on MOCK_PROVIDER_PORT (default 18081)
# that requires `Bearer sk-mock-good`, emits one tool call round then content,
# and serves GET /v1/models. The script creates its own throwaway project so it
# never touches real data.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
LXK_API_KEY="${LXK_API_KEY:?LXK_API_KEY required}"
MOCK_PORT="${MOCK_PROVIDER_PORT:-18081}"
MOCK_KEY="sk-mock-good"
BAD_KEY="sk-wrong"
TMPDIR_SMOKE="$(mktemp -d)"
trap 'kill $MOCK_PID 2>/dev/null || true; rm -rf "$TMPDIR_SMOKE"' EXIT

echo "== mock provider on :$MOCK_PORT =="
cat > "$TMPDIR_SMOKE/mock.ts" <<'MOCK_EOF'
const KEY = process.env.MOCK_KEY!;
const PORT = Number(process.env.MOCK_PORT!);
function sse(chunks: unknown[]) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}
const chunk = (id: string, delta: Record<string, unknown>, finish: string | null = null) => ({
  id, object: 'chat.completion.chunk', created: 1, model: 'mock-mini',
  choices: [{ index: 0, delta, finish_reason: finish }],
});
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/models')) {
      if (req.headers.get('authorization') !== `Bearer ${KEY}`) return new Response('unauthorized', { status: 401 });
      return Response.json({ data: [{ id: 'mock-mini' }, { id: 'mock-large' }] });
    }
    if (url.pathname.endsWith('/chat/completions')) {
      if (req.headers.get('authorization') !== `Bearer ${KEY}`)
        return Response.json({ error: { message: 'Incorrect API key' } }, { status: 401 });
      const body = (await req.json()) as { messages: Array<{ role: string }> };
      const sawToolResult = JSON.stringify(body.messages).includes('"role":"tool"');
      if (!sawToolResult) {
        return sse([
          chunk('c1', { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"lexa"}' } }] }),
          chunk('c1', {}, 'tool_calls'),
        ]);
      }
      return sse([
        chunk('c2', { content: 'Hello from mock' }),
        chunk('c2', { content: ' provider.' }),
        chunk('c2', {}, 'stop'),
        { id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'mock-mini', choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 11, completion_tokens: 4 } },
      ]);
    }
    return new Response('not found', { status: 404 });
  },
});
console.log('mock up');
MOCK_EOF
MOCK_KEY="$MOCK_KEY" MOCK_PORT="$MOCK_PORT" bun "$TMPDIR_SMOKE/mock.ts" &
MOCK_PID=$!
sleep 1

api() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }
api_body() { curl -sS "$@"; }
auth=(-H "Authorization: Bearer $LXK_API_KEY" -H "Content-Type: application/json")
json() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d))' 2>/dev/null || cat; }

fail() { echo "FAIL: $1"; exit 1; }

echo
echo "== 1. unauthenticated → expect 401 =="
code=$(api "$BASE_URL/api/herald/settings/nope")
[ "$code" = "401" ] || fail "expected 401 got $code"
echo "401 OK"

echo
echo "== setup: create throwaway project + agent + skill =="
proj=$(api_body "${auth[@]}" -X POST "$BASE_URL/api/projects" -d "{\"name\":\"herald-smoke-$$\",\"slug\":\"herald-smoke-$$\"}")
PROJECT_ID=$(echo "$proj" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
SLUG="herald-smoke-$$"
agent=$(api_body "${auth[@]}" -X POST "$BASE_URL/api/agents" -d "{\"name\":\"smoke-agent-$$\",\"description\":\"smoke\",\"instructions\":\"Be terse.\"}")
AGENT_ID=$(echo "$agent" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
skill=$(api_body "${auth[@]}" -X POST "$BASE_URL/api/skills" -d "{\"name\":\"smoke-skill-$$\",\"description\":\"smoke\",\"instructions\":\"Reply in one line.\"}")
SKILL_ID=$(echo "$skill" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
board=$(api_body "${auth[@]}" "$BASE_URL/api/projects/$SLUG/board")
COLUMN_ID=$(echo "$board" | python3 -c 'import json,sys; print(json.load(sys.stdin)["columns"][0]["id"])')
task=$(api_body "${auth[@]}" -X POST "$BASE_URL/api/projects/$SLUG/tasks" -d "{\"columnId\":\"$COLUMN_ID\",\"title\":\"smoke doc\"}")
echo "(project $PROJECT_ID created)"

echo
echo "== 2. enqueue without provider config → expect 409 PROVIDER_NOT_CONFIGURED =="
resp=$(api_body "${auth[@]}" -w '\n%{http_code}' -X POST "$BASE_URL/api/herald/tasks" \
  -d "{\"slug\":\"$SLUG\",\"documentType\":\"task\",\"documentId\":\"PENDING\",\"prompt\":\"hi\",\"agentId\":\"$AGENT_ID\",\"skillId\":\"$SKILL_ID\"}")
code=$(echo "$resp" | tail -1); body=$(echo "$resp" | head -1)
[ "$code" = "409" ] || fail "expected 409 got $code: $body"
echo "$body" | grep -q PROVIDER_NOT_CONFIGURED || fail "missing code: $body"
echo "409 PROVIDER_NOT_CONFIGURED OK"

echo
echo "== 3. test connection with bad key → expect 502 PROVIDER_AUTH_FAILED =="
resp=$(api_body "${auth[@]}" -w '\n%{http_code}' -X POST "$BASE_URL/api/herald/settings/$PROJECT_ID/test" \
  -d "{\"kind\":\"openai_compatible\",\"baseUrl\":\"http://localhost:$MOCK_PORT\",\"model\":\"mock-mini\",\"apiKey\":\"$BAD_KEY\"}")
code=$(echo "$resp" | tail -1); body=$(echo "$resp" | head -1)
[ "$code" = "502" ] || fail "expected 502 got $code: $body"
echo "$body" | grep -q PROVIDER_AUTH_FAILED || fail "missing code: $body"
echo "502 PROVIDER_AUTH_FAILED OK"

echo
echo "== 4. models list happy path → expect mock ids =="
resp=$(api_body "${auth[@]}" -X POST "$BASE_URL/api/herald/settings/$PROJECT_ID/models" \
  -d "{\"kind\":\"openai_compatible\",\"baseUrl\":\"http://localhost:$MOCK_PORT\",\"model\":\"mock-mini\",\"apiKey\":\"$MOCK_KEY\"}")
echo "$resp" | grep -q '"mock-large"' || fail "unexpected: $resp"
echo "$resp"

echo
echo "== 5. save settings → masked view =="
resp=$(api_body "${auth[@]}" -X PUT "$BASE_URL/api/herald/settings/$PROJECT_ID" \
  -d "{\"kind\":\"openai_compatible\",\"baseUrl\":\"http://localhost:$MOCK_PORT\",\"model\":\"mock-mini\",\"apiKey\":\"$MOCK_KEY\"}")
echo "$resp"
echo "$resp" | grep -q '"hasKey":true' || fail "masked view wrong"

echo
echo "== 6. memory CRUD =="
mem=$(api_body "${auth[@]}" -X POST "$BASE_URL/api/herald/memory/$PROJECT_ID" -d '{"content":"Prefers terse answers"}')
MEM_ID=$(echo "$mem" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
list=$(api_body "${auth[@]}" "$BASE_URL/api/herald/memory/$PROJECT_ID")
echo "$list" | grep -q "Prefers terse answers" || fail "memory list missing entry"
code=$(api "${auth[@]}" -X DELETE "$BASE_URL/api/herald/memory/$PROJECT_ID/$MEM_ID")
[ "$code" = "204" ] || fail "memory delete got $code"
echo "CRUD OK"

echo
echo "== 7. document task SSE stream (tool frame + done) =="
doc=$(api_body "${auth[@]}" "$BASE_URL/api/projects/$SLUG/tasks" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])')
created=$(api_body "${auth[@]}" -X POST "$BASE_URL/api/herald/tasks" \
  -d "{\"slug\":\"$SLUG\",\"documentType\":\"task\",\"documentId\":\"$doc\",\"prompt\":\"greet me\",\"agentId\":\"$AGENT_ID\",\"skillId\":\"$SKILL_ID\"}")
TASK_ID=$(echo "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "-- frames:"
curl -sS -N --max-time 30 "${auth[@]}" -X POST "$BASE_URL/api/herald/tasks/$TASK_ID/stream" | head -20
status=$(api_body "${auth[@]}" "$BASE_URL/api/forge/tasks/$TASK_ID")
echo "-- task after stream:"
echo "$status" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["status"], "| result:", d.get("result"))'
echo "$status" | grep -q '"completed"' || fail "task not done"

echo
echo "== 8. chat: stream → transcript → reset =="
CHAT_ID="smoke-chat-$$"
echo "-- frames:"
curl -sS -N --max-time 30 "${auth[@]}" -X POST "$BASE_URL/api/herald/chat/stream" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"chatId\":\"$CHAT_ID\",\"message\":\"hello\"}" | head -10
tr=$(api_body "${auth[@]}" "$BASE_URL/api/herald/chat/$CHAT_ID")
echo "-- transcript:"
echo "$tr" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("messages:", len(d["messages"]), "| summary:", d["summary"])'
code=$(api "${auth[@]}" -X DELETE "$BASE_URL/api/herald/chat/$CHAT_ID")
[ "$code" = "204" ] || fail "chat reset got $code"
code=$(api "${auth[@]}" "$BASE_URL/api/herald/chat/$CHAT_ID")
[ "$code" = "404" ] || fail "post-reset transcript expected 404 got $code"
echo "chat OK"

echo
echo "== cleanup =="
curl -sS -o /dev/null "${auth[@]}" -X DELETE "$BASE_URL/api/projects/$SLUG"
echo "ALL SMOKE CHECKS PASSED"
