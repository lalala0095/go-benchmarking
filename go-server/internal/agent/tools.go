package agent

import (
	"context"
	"math"
	"time"
	_ "time/tzdata" // distroless has no zoneinfo; embed it for get_current_time

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/jackc/pgx/v5/pgxpool"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/lalala0095/go-benchmarking/go-server/internal/instrument"
	"github.com/lalala0095/go-benchmarking/go-server/internal/rag"
)

// Tool names and descriptions (contracts/agent-spec.md).
const (
	ToolSearch    = "search_knowledge_base"
	ToolInventory = "get_inventory_stats"
	ToolTime      = "get_current_time"

	descSearch    = "Search the project knowledge base and return the most relevant passages."
	descInventory = "Get inventory statistics (count, avg/min/max price) for a product category."
	descTime      = "Get the current time in an IANA timezone."

	// ToolContentMax is the max code points of content in tool results.
	ToolContentMax = 800
)

// InventorySQL is the shared inventory aggregate.
const InventorySQL = `SELECT count(*)::int, coalesce(avg(price),0)::float8, coalesce(min(price),0)::float8, coalesce(max(price),0)::float8 FROM app.bench_items WHERE category = $1`

type searchArgs struct {
	Query string `json:"query"`
	TopK  *int   `json:"top_k,omitempty"`
}

type inventoryArgs struct {
	Category string `json:"category"`
}

type timeArgs struct {
	Timezone string `json:"timezone"`
}

func objSchema(required []string, props map[string]*jsonschema.Schema) *jsonschema.Schema {
	return &jsonschema.Schema{Type: "object", Properties: props, Required: required}
}

// EmbedderChooser picks the embedder name for the search tool.
type EmbedderChooser func(ctx context.Context) (name string, dbTime time.Duration)

// Round2 rounds half away from zero to 2 decimal places.
func Round2(v float64) float64 { return math.Round(v*100) / 100 }

// Truncate returns at most n code points of s.
func Truncate(s string, n int) string {
	i := 0
	for pos := range s {
		if i == n {
			return s[:pos]
		}
		i++
	}
	return s
}

// NewTools builds the three function tools. choose selects the embedder for
// search_knowledge_base (one tool instance per agent).
func NewTools(pool *pgxpool.Pool, rs *rag.Service, choose EmbedderChooser) ([]tool.Tool, error) {
	search, err := functiontool.New(functiontool.Config{
		Name:        ToolSearch,
		Description: descSearch,
		InputSchema: objSchema([]string{"query"}, map[string]*jsonschema.Schema{
			"query": {Type: "string", Description: "The search query."},
			"top_k": {Type: "integer", Description: "Number of passages to return (1-20, default 5)."},
		}),
	}, func(ctx adkagent.Context, a searchArgs) (map[string]any, error) {
		k := 5
		if a.TopK != nil {
			k = min(max(*a.TopK, 1), 20)
		}
		emb, chooseDB := choose(ctx)
		res, t, err := rs.Search(ctx, a.Query, k, rag.ModeHybrid, emb)
		instrument.From(ctx).ToolExtra(ctx.FunctionCallID(), instrument.Round3(t.EmbedMs), instrument.Round3(t.DBMs+instrument.Ms(chooseDB)))
		if err != nil {
			return nil, err
		}
		out := make([]any, 0, len(res))
		for _, r := range res {
			out = append(out, map[string]any{"source": r.Source, "heading": r.Heading, "content": Truncate(r.Content, ToolContentMax)})
		}
		return map[string]any{"results": out}, nil
	})
	if err != nil {
		return nil, err
	}

	inventory, err := functiontool.New(functiontool.Config{
		Name:        ToolInventory,
		Description: descInventory,
		InputSchema: objSchema([]string{"category"}, map[string]*jsonschema.Schema{
			"category": {Type: "string", Description: "Product category, e.g. electronics."},
		}),
	}, func(ctx adkagent.Context, a inventoryArgs) (map[string]any, error) {
		var count int
		var avg, mn, mx float64
		if err := pool.QueryRow(ctx, InventorySQL, a.Category).Scan(&count, &avg, &mn, &mx); err != nil {
			return nil, err
		}
		return map[string]any{
			"category": a.Category, "count": count,
			"avg_price": Round2(avg), "min_price": Round2(mn), "max_price": Round2(mx),
		}, nil
	})
	if err != nil {
		return nil, err
	}

	clock, err := functiontool.New(functiontool.Config{
		Name:        ToolTime,
		Description: descTime,
		InputSchema: objSchema([]string{"timezone"}, map[string]*jsonschema.Schema{
			"timezone": {Type: "string", Description: "IANA timezone name, e.g. UTC or Asia/Manila."},
		}),
	}, func(ctx adkagent.Context, a timeArgs) (map[string]any, error) {
		return CurrentTime(a.Timezone, time.Now()), nil
	})
	if err != nil {
		return nil, err
	}
	return []tool.Tool{search, inventory, clock}, nil
}

// CurrentTime implements get_current_time: RFC 3339, second precision
// ("Z" for UTC, numeric offset otherwise).
func CurrentTime(tz string, now time.Time) map[string]any {
	out := map[string]any{"timezone": tz}
	var loc *time.Location
	var err error
	if tz != "" && tz != "Local" {
		loc, err = time.LoadLocation(tz)
	}
	if loc == nil || err != nil {
		loc = time.UTC
		out["timezone"] = "UTC"
		out["note"] = "unknown timezone, used UTC"
	}
	out["iso"] = now.In(loc).Format(time.RFC3339)
	return out
}

// BeforeTool starts timing a tool call in the request accumulator.
func BeforeTool(ctx adkagent.Context, t tool.Tool, args map[string]any) (map[string]any, error) {
	instrument.From(ctx).ToolStart(ctx.FunctionCallID(), t.Name(), args)
	return nil, nil
}

// AfterTool finishes timing a tool call (adds to tool_ms).
func AfterTool(ctx adkagent.Context, t tool.Tool, args, result map[string]any, err error) (map[string]any, error) {
	instrument.From(ctx).ToolEnd(ctx.FunctionCallID(), result, err)
	return nil, nil
}
