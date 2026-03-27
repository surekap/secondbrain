require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env.local") });
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const llm = require('../shared/llm');

class LifelogAgent {
  constructor() {
    this.db = new Pool({ connectionString: process.env.DATABASE_URL });

    this.initDatabase();

    this.tools = this.loadMCPTools();
  }

  async processLifelog(lifelog) {
    console.log(`🤖 Processing lifelog: ${lifelog.title}`);

    const content = this.formatLifelogContent(lifelog);

    const systemPrompt = `
    # Task Processing Agent System Instructions

    You are an autonomous task execution agent that processes text inputs and executes complex, multi-step tasks using available tools. Your responses are not read by humans - focus entirely on accurate tool execution.

    ## Core Principles

    1. **Task Identification**: Only process inputs that contain explicit task directions. Ignore conversational text between multiple people - only act on text specifically directed as instructions to you.

    2. **Systematic Planning**: For every identified task, create a detailed execution plan before making any tool calls. Break complex tasks into logical, sequential steps.

    3. **Schema-First Approach**: When working with data organization tools (like Notion), design thoughtful, well-structured schemas with useful columns which enable critical decision making before adding data to all columns. Create databases with appropriate properties, types, and relationships. Do not create duplicate databases - add columns to existing datases of a given type if available and back-fill the data.

    4. **Type Safety**: All tool parameters must be precisely typed and validated. Double-check parameter formats, required fields, and data types before each tool call.

    5. **Research Thoroughness**: When tasks involve research, gather comprehensive information before proceeding with data organization or output generation.

    6. **Todo Management**: We use a todo system which supports projects and multiple people in each project. Comments can be added to todos to provide updates or additional context. Comments are the primary way to communicate with the person to whom the todo is assigned. Use this system to track task progress and communicate updates.

    ## Task Processing Workflow

    ### Step 1: Task Detection and Parsing
    - Analyze input text to determine if it contains actionable task instructions
    - If no clear task is identified, respond with: "No actionable task detected in input"
    - Extract key requirements, constraints, and success criteria from identified tasks

    ### Step 2: Planning Phase
    Create a detailed execution plan that includes:
    - Primary objective and sub-goals
    - Required tools and their sequence of use
    - Data structures and schemas needed
    - Dependencies between steps
    - Expected outputs and deliverables

    ### Step 3: Schema Design (when applicable)
    For tasks involving data organization:
    - Design logical database schemas with appropriate field types
    - Consider relationships between different data entities
    - Plan for scalability and future data additions
    - Create clear naming conventions

    ### Step 4: Sequential Execution
    - Execute tools in planned sequence
    - Validate each tool response before proceeding
    - Handle errors gracefully and retry with corrected parameters
    - Maintain data consistency across tool calls

    ### Step 5: Verification
    - Confirm task completion against original requirements
    - Verify data integrity and completeness
    - Ensure all deliverables meet specified criteria

    ## Available Tool Categories

    - **Research Tools**: Stock research, market analysis, data gathering
    - **Communication Tools**: Email reading, email sending
    - **Task Management**: Todo creation, todo commenting, task tracking
    - **Data Organization**: Notion database creation, data entry, structure management

    ## CRITICAL DATABASE WORKFLOW

    **MANDATORY SCHEMA COMPLIANCE**: When working with databases, you MUST follow this exact sequence:

    1. **Create Database**: Use create_database to create new databases
    2. **Get Schema**: IMMEDIATELY call find_database to get the EXACT column names that were created
    3. **Use Exact Columns**: Use the EXACT column names from find_database in your add_to_database calls

    **NEVER guess column names**. Always use find_database first to see the actual schema.

    Example:
    - create_database(name="Wine Collection", type="wines")
    - find_database(name="Wine Collection") → returns exact columns like "Wine Name", "Vintage Year", "Rating"
    - add_to_database(row_data={"Wine Name": "Château Margaux", "Vintage Year": 2015, "Rating": 95})

    ## Response Format

    For identified tasks, structure your response as:


    TASK IDENTIFIED: [Brief task summary]

    EXECUTION PLAN:
    1. [Step 1 with tool(s) to use]
    2. [Step 2 with tool(s) to use]
    3. [Continue...]

    EXECUTING:


    Then proceed with actual tool calls in sequence.

    For non-tasks, simply respond: "No actionable task detected in input"

    ## Quality Standards

    - **Accuracy**: All data must be factually correct and properly sourced
    - **Completeness**: Tasks must be fully completed, not partially executed
    - **Organization**: Data structures must be logical, searchable, and maintainable
    - **Efficiency**: Use minimum necessary tool calls while maintaining quality
    - **Reliability**: Handle edge cases and validate all inputs/outputs

    ## Error Handling

    - If a tool call fails, analyze the error and retry with corrected parameters
    - If multiple attempts fail, document the issue and continue with remaining steps
    - Never abandon a task due to single tool failure - find alternative approaches
    - Maintain detailed logs of any issues encountered during execution

    Remember: You are executing tasks autonomously. Focus on accuracy, completeness, and systematic execution rather than explanatory text.
    `;

    const prompt = content;

    try {
      const toolDefinitions = this.tools.flatMap((tool) =>
        tool.getToolDefinitions()
      );

      await this._runAI(systemPrompt, prompt, toolDefinitions);

      await this.markLifelogProcessed(lifelog.id);
      console.log(`✅ Completed processing lifelog: ${lifelog.id}`);
    } catch (error) {
      console.error(
        `❌ Error processing lifelog ${lifelog.id}:`,
        error.message
      );
      await this.markLifelogFailed(lifelog.id, error.message);
    }
  }

  async _runAI(systemPrompt, prompt, toolDefinitions) {
    const messages = [{ role: "user", content: prompt }];
    let maxTurns = 5;
    let turnCount = 0;

    while (turnCount < maxTurns) {
      turnCount++;
      console.log(`🔄 Turn ${turnCount}: Calling AI...`);

      const response = await llm.create('limitless', {
        system: systemPrompt,
        messages,
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
        max_tokens: 4000,
      });

      console.log(`🧠 AI response (${response.provider}): stop_reason=${response.stop_reason}, tool_calls=${response.tool_calls.length}`);

      const hasToolCalls = response.tool_calls.length > 0;

      // Build assistant message in normalized format
      const assistantMsg = {
        role: "assistant",
        content: response.text || null,
        tool_calls: response.tool_calls,
      };
      messages.push(assistantMsg);

      if (hasToolCalls) {
        for (const tc of response.tool_calls) {
          console.log(`📞 Tool call found: ${tc.name}`);
          const result = await this.executeTool(tc.name, tc.input);
          messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
        }
        messages.push({
          role: "user",
          content: 'Continue with any remaining actions needed to complete the user\'s requests. If all requests are fully completed, respond with "WORKFLOW_COMPLETE".',
        });
      } else {
        const lastText = response.text || "";
        if (lastText.includes("WORKFLOW_COMPLETE") || (!lastText.toLowerCase().includes("next") && !lastText.toLowerCase().includes("continue"))) {
          console.log("✅ AI indicates workflow is complete");
          break;
        }
      }
    }
  }

  async executeTool(toolName, input) {
    console.log(`🔧 Executing tool: ${toolName}`);

    for (const tool of this.tools) {
      if (tool.canHandle(toolName)) {
        try {
          const result = await tool.execute(toolName, input);
          console.log(`✅ Tool ${toolName} completed:`, result);
          return result;
        } catch (error) {
          console.error(`❌ Tool ${toolName} failed:`, error.message);
          throw error;
        }
      }
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }

  formatLifelogContent(lifelog) {
    const parts = [];

    if (lifelog.title) parts.push(`Title: ${lifelog.title}`);
    if (lifelog.start_time) parts.push(`Time: ${lifelog.start_time}`);
    if (lifelog.markdown) parts.push(`Content: ${lifelog.markdown}`);
    else if (lifelog.contents) {
      try {
        const parsed =
          typeof lifelog.contents === "string"
            ? JSON.parse(lifelog.contents)
            : lifelog.contents;
        parts.push(`Content: ${JSON.stringify(parsed)}`);
      } catch {
        parts.push(`Content: ${lifelog.contents}`);
      }
    }

    return parts.join("\n");
  }

  async getUnprocessedLifelogs(limit = 10) {
    // Fetch unprocessed lifelogs, including previously failed ones (up to 3 attempts)
    const { rows } = await this.db.query(
      `SELECT * FROM lifelogs
       WHERE processed = FALSE
         AND (processing_attempts IS NULL OR processing_attempts < 3)
       ORDER BY
         CASE WHEN processing_error IS NULL THEN 0 ELSE 1 END,  -- fresh first, retries last
         start_time DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }

  async markLifelogProcessed(lifelogId) {
    await this.db.query(
      "UPDATE lifelogs SET processed = TRUE, processing_error = NULL, last_attempt_at = NOW() WHERE id = $1",
      [lifelogId]
    );
  }

  async markLifelogFailed(lifelogId, errorMsg) {
    await this.db.query(
      `UPDATE lifelogs
       SET processing_error = $2,
           processing_attempts = COALESCE(processing_attempts, 0) + 1,
           last_attempt_at = NOW()
       WHERE id = $1`,
      [lifelogId, errorMsg]
    );
  }

  async initDatabase() {
    try {
      await this.db.query("SELECT 1");
      console.log("✅ Database connection established");
    } catch (error) {
      console.error("❌ Database connection failed:", error.message);
    }
  }

  loadMCPTools() {
    const toolsDir = path.join(__dirname, "tools");
    const tools = [];

    try {
      const files = fs.readdirSync(toolsDir);

      const mcpFiles = files.filter(
        (file) => file.endsWith("-mcp.js") && !file.includes("disabled")
      );

      console.log(
        `🔍 Found ${mcpFiles.length} MCP tools: ${mcpFiles.join(", ")}`
      );

      for (const file of mcpFiles) {
        try {
          const toolPath = path.join(toolsDir, file);
          const MCPClass = require(toolPath);
          const toolInstance = new MCPClass();
          tools.push(toolInstance);

          const toolName = MCPClass.name || file.replace("-mcp.js", "");
          console.log(`✅ Loaded MCP tool: ${toolName}`);
        } catch (error) {
          console.error(`❌ Failed to load MCP tool ${file}:`, error.message);
        }
      }

      console.log(`🚀 Successfully loaded ${tools.length} MCP tools\n`);
    } catch (error) {
      console.error("❌ Error scanning tools directory:", error.message);
    }

    return tools;
  }

  async processBatch(batchSize = 5) {
    console.log(
      `🚀 Starting agent-based batch processing (${batchSize} lifelogs)`
    );

    try {
      const lifelogs = await this.getUnprocessedLifelogs(batchSize);

      if (lifelogs.length === 0) {
        console.log("No unprocessed lifelogs found");
        return;
      }

      console.log(`Found ${lifelogs.length} unprocessed lifelogs`);

      for (const lifelog of lifelogs) {
        await this.processLifelog(lifelog);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      console.log(`✅ Batch completed: processed ${lifelogs.length} lifelogs`);
    } catch (error) {
      console.error("❌ Batch processing error:", error);
    }
  }
}

module.exports = LifelogAgent;

if (require.main === module) {
  const agent = new LifelogAgent();

  setInterval(async () => {
    await agent.processBatch();
  }, 30000);

  agent.processBatch();

  const provider = process.env.AI_PROVIDER || 'anthropic';
  console.log(`🤖 Lifelog Agent started - processing every 30 seconds (provider: ${provider})`);
}
