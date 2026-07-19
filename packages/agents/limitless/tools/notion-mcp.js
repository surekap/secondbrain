/**
 * NOTION MCP TOOL v2.0 - DYNAMIC DECISION-FOCUSED DATABASE CREATION
 * 
 * This MCP tool creates Notion databases with AI-generated schemas optimized
 * for decision-making rather than just fact storage.
 * 
 * KEY FEATURES:
 * - AI-powered schema generation using Claude
 * - Decision-focused columns (buy/sell/hold, use/store, ratings, timeframes)
 * - Purpose-driven field selection based on use case
 * - Multi-strategy intelligent database discovery:
 *   1. Scoped search (only under parent page)
 *   2. Basic string matching (fast, reliable)  
 *   3. AI heuristic matching (semantic understanding)
 * - Schema-aware data entry workflow:
 *   1. find_database returns database + schema information
 *   2. Agent processes data according to schema requirements
 *   3. add_to_database accepts properly formatted row_data object
 * - Intelligent value formatting (auto-detects dates, numbers, select options, files, etc.)
 * - Comprehensive file handling (local paths, URLs, cloud storage links)
 * 
 * SCHEMA PHILOSOPHY:
 * Instead of storing facts, we store ACTIONABLE INFORMATION:
 * - Wines: Drinking windows, storage temps, investment grades, ready-to-drink status
 * - Stocks: Target prices, stop losses, risk levels, position sizing, timeframes
 * - Equipment: Value ratings, compatibility scores, buy/wait decisions
 * - Plants: pH levels, nutrient schedules, harvest dates, health status
 * 
 * ENVIRONMENT VARIABLES:
 * - NOTION_TOKEN: Notion integration token
 * - ANTHROPIC_API_KEY: Required for dynamic schema generation
 */

const { Client } = require('@notionhq/client');
const llm = require('../../shared/llm');

class NotionMCP {
  constructor() {
    this.notion = new Client({
      auth: process.env.NOTION_TOKEN,
    });
    this.parentPageId = '25051a7a4e068074a327d21b3df6a7b4'; // Default parent page
  }

  getToolDefinitions() {
    return [
      {
        name: 'create_database',
        description: 'Create a new Notion database with intelligent schema',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Database name'
            },
            type: {
              type: 'string',
              description: 'Type of database (wines, stocks, home_theater, etc.)'
            },
            purpose: {
              type: 'string',
              description: 'Purpose or use case for the database'
            }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'add_to_database',
        description: 'Add a properly formatted row to a Notion database using schema-compliant data. CRITICAL: You must use find_database first to get the exact column names and schema, then use those EXACT column names in row_data.',
        input_schema: {
          type: 'object',
          properties: {
            database_id: {
              type: 'string',
              description: 'Notion database ID (get this from find_database result)'
            },
            row_data: {
              type: 'object',
              description: 'Object with column names as keys (use EXACT column names from find_database schema) and properly formatted values. Example: {"System Name": "Sony TV", "Value Rating": "Excellent"}'
            },
            subject: {
              type: 'string',
              description: 'Subject being added (for logging/context only, optional)'
            },
            context: {
              type: 'string',
              description: 'Additional context (optional)'
            }
          },
          required: ['database_id', 'row_data']
        }
      },
      {
        name: 'find_database',
        description: 'Find existing database by name/type',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Database name to search for'
            },
            type: {
              type: 'string',
              description: 'Database type to search for'
            }
          }
        }
      }
    ];
  }

  canHandle(toolName) {
    return ['create_database', 'add_to_database', 'find_database'].includes(toolName);
  }

  async execute(toolName, input) {
    switch (toolName) {
      case 'create_database':
        return await this.createDatabase(input);
      case 'add_to_database':
        return await this.addToDatabase(input);
      case 'find_database':
        return await this.findDatabase(input);
      default:
        throw new Error(`Unknown Notion tool: ${toolName}`);
    }
  }

  async createDatabase({ name, type, purpose = '' }) {
    try {
      const schema = await this.generateSchema(type, purpose);
      
      const response = await this.notion.databases.create({
        parent: {
          type: 'page_id',
          page_id: this.parentPageId
        },
        title: [{
          type: 'text',
          text: { content: name }
        }],
        properties: schema
      });

      return {
        success: true,
        database_id: response.id,
        database_url: response.url,
        schema_columns: Object.keys(schema).length,
        message: `Created ${type} database: ${name}`
      };

    } catch (error) {
      console.error('Notion database creation error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async generateSchema(type, purpose) {
    try {
      const prompt = `Generate a Notion database schema for decision-making purposes.

TYPE: ${type}
PURPOSE: ${purpose || 'General tracking and decision support'}

REQUIREMENTS:
1. Focus on DECISION-MAKING columns, not just facts
2. Include critical variables for yes/no, buy/sell/hold, use/store decisions
3. Maximum 12-15 columns to keep manageable
4. Use appropriate Notion field types

EXAMPLES OF DECISION-FOCUSED COLUMNS:
- Wines: WS Rating, RP Rating, Drinking Window, Ready to Drink (checkbox), Storage Temp, Investment Grade (checkbox), Action (DRINK NOW/CELLAR/SELL)
- Stocks: Current Price, Target Price, Upside %, Recommendation (BUY/HOLD/SELL), Risk Level, Timeframe, Stop Loss, Position Size %
- Home Theater: Value Rating, Room Size Match, Buy Decision (BUY NOW/WAIT/PASS), In Stock (checkbox), Power Requirements
- Hydroponics: pH Level, EC Level, Action Needed (URGENT pH/Water Change/Monitor), Health Status, Days to Harvest
- Cars: Reliability Score, Maintenance Cost, Resale Value, Buy/Lease Decision, Insurance Group

NOTION FIELD TYPES:
- title: {} (for main identifier)
- rich_text: {} (for text)
- number: { format: "number" | "dollar" | "percent" }
- select: { options: [{ name: "Option", color: "green" }] }
- multi_select: { options: [] }
- date: {}
- checkbox: {}
- url: {}

Return ONLY valid JSON in this exact format:
{
  "Column Name": { "field_type": { "format": "optional" } },
  "Decision Column": { "select": { "options": [{"name": "Option1", "color": "green"}] } }
}

Focus on what someone needs to make smart decisions about ${type}.`;

      const response = await llm.create('limitless', {
        profile: 'bulk_structured',
        task_type: 'notion_schema_generation_json',
        workflow_name: 'lifelog_processing',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });

      const schemaText = response.text || '';
      
      // Extract JSON from Claude's response
      const jsonMatch = schemaText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON schema found in Claude response');
      }

      const schema = JSON.parse(jsonMatch[0]);
      console.log(`✅ Generated dynamic schema for ${type} with ${Object.keys(schema).length} decision-focused columns`);
      
      return schema;

    } catch (error) {
      console.error('Schema generation error:', error.message);
      
      // Fallback to basic decision-focused schema
      return {
        'Name': { title: {} },
        'Decision': { 
          select: { 
            options: [
              { name: 'BUY', color: 'green' },
              { name: 'HOLD', color: 'yellow' },
              { name: 'SELL', color: 'red' },
              { name: 'USE', color: 'blue' },
              { name: 'STORE', color: 'purple' }
            ]
          }
        },
        'Priority': {
          select: {
            options: [
              { name: 'High', color: 'red' },
              { name: 'Medium', color: 'yellow' },
              { name: 'Low', color: 'gray' }
            ]
          }
        },
        'Rating': { number: { format: 'number' } },
        'Price/Value': { number: { format: 'dollar' } },
        'Action Needed': { rich_text: {} },
        'Deadline': { date: {} },
        'Status': {
          select: {
            options: [
              { name: 'Active', color: 'green' },
              { name: 'Monitoring', color: 'yellow' },
              { name: 'Completed', color: 'blue' }
            ]
          }
        },
        'Notes': { rich_text: {} }
      };
    }
  }

  async findDatabase({ name, type }) {
    try {
      console.log(`🔍 Searching for database: name="${name}", type="${type}"`);
      
      // Step 1: Get databases only under our parent page (scoped search)
      const childDatabases = await this.getDatabasesUnderParent(this.parentPageId);
      
      if (childDatabases.length === 0) {
        console.log('📝 No databases found under parent page');
        return {
          success: true,
          databases: [],
          found: false,
          message: 'No databases found under parent page',
          strategy: 'scoped_search'
        };
      }

      console.log(`📊 Found ${childDatabases.length} databases under parent page`);

      // Step 2: Basic string matching first (fast and reliable)
      const exactMatches = this.findExactMatches(childDatabases, name, type);
      
      if (exactMatches.length > 0) {
        console.log(`✅ Found ${exactMatches.length} exact matches using basic string matching`);
        const databasesWithSchema = await this.addSchemaToResults(exactMatches);
        return {
          success: true,
          databases: databasesWithSchema,
          found: true,
          message: `Found ${exactMatches.length} exact matches`,
          strategy: 'exact_match'
        };
      }

      // Step 3: AI-powered heuristic matching for ambiguous cases
      console.log('🤖 No exact matches found, trying AI heuristic matching...');
      const heuristicMatches = await this.findHeuristicMatches(childDatabases, name, type);
      
      if (heuristicMatches.length > 0) {
        const databasesWithSchema = await this.addSchemaToResults(heuristicMatches);
        return {
          success: true,
          databases: databasesWithSchema,
          found: true,
          message: `Found ${heuristicMatches.length} matches using AI heuristics`,
          strategy: 'ai_heuristic',
          totalDatabases: childDatabases.length
        };
      }
      
      return {
        success: true,
        databases: [],
        found: false,
        message: 'No matching databases found',
        strategy: 'no_match',
        totalDatabases: childDatabases.length
      };

    } catch (error) {
      console.error('Notion database search error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getDatabasesUnderParent(parentPageId) {
    try {
      // Get all child blocks under the parent page
      const childBlocks = await this.notion.blocks.children.list({
        block_id: parentPageId
      });

      // Filter for database blocks
      const databases = childBlocks.results
        .filter(block => block.type === 'child_database')
        .map(block => ({
          id: block.id,
          title: block.child_database?.title || 'Untitled Database',
          url: `https://notion.so/${block.id.replace(/-/g, '')}`
        }));

      // Also search for databases that might be children of the parent page directly
      const searchResponse = await this.notion.search({
        filter: {
          value: 'database',
          property: 'object'
        }
      });

      // Filter to only databases that are actually under our parent page
      const parentDatabases = searchResponse.results.filter(db => {
        return db.parent?.type === 'page_id' && db.parent.page_id === parentPageId;
      }).map(db => ({
        id: db.id,
        title: db.title[0]?.text?.content || 'Untitled',
        url: db.url
      }));

      // Combine and deduplicate
      const allDatabases = [...databases, ...parentDatabases];
      const uniqueDatabases = allDatabases.filter((db, index, self) => 
        index === self.findIndex(d => d.id === db.id)
      );

      return uniqueDatabases;

    } catch (error) {
      console.error('Error getting databases under parent:', error);
      return [];
    }
  }

  findExactMatches(databases, name, type) {
    const matches = [];

    for (const db of databases) {
      const titleLower = db.title.toLowerCase();
      
      // Exact name match
      if (name && titleLower.includes(name.toLowerCase())) {
        console.log(`✅ Exact name match: "${db.title}" contains "${name}"`);
        matches.push(db);
        continue;
      }

      // Type-based matching with common patterns
      if (type) {
        const typeLower = type.toLowerCase();
        
        // Common type patterns
        const typePatterns = {
          'wine': ['wine', 'cellar', 'vineyard'],
          'stock': ['stock', 'equity', 'investment', 'portfolio'],
          'home_theater': ['home theater', 'audio', 'speaker', 'sound'],
          'hydroponic': ['hydroponic', 'plant', 'grow', 'garden'],
          'car': ['car', 'vehicle', 'auto'],
          'book': ['book', 'library', 'reading'],
          'restaurant': ['restaurant', 'dining', 'food']
        };

        const patterns = typePatterns[typeLower] || [typeLower];
        
        for (const pattern of patterns) {
          if (titleLower.includes(pattern)) {
            console.log(`✅ Type pattern match: "${db.title}" matches pattern "${pattern}" for type "${type}"`);
            matches.push(db);
            break;
          }
        }
      }
    }

    // Remove duplicates
    return matches.filter((db, index, self) => 
      index === self.findIndex(d => d.id === db.id)
    );
  }

  async findHeuristicMatches(databases, name, type) {
    try {
      if (databases.length === 0) return [];

      const databaseList = databases.map(db => `"${db.title}"`).join(', ');
      const searchTerm = name || type || '';

      const prompt = `You are helping find the best matching database from a list.

SEARCH TERM: "${searchTerm}"
AVAILABLE DATABASES: ${databaseList}

TASK: Determine if there is a clear semantic match between the search term and any of the database names.

MATCHING RULES:
1. Look for semantic similarity (e.g., "wine" matches "Wine Cellar", "stocks" matches "Investment Portfolio")
2. Consider synonyms and related terms (e.g., "home theater" matches "Audio Systems") 
3. Only return matches if you're confident (>80% sure)
4. Consider purpose and context (e.g., "trading" could match "Stock Analysis")

RESPONSE FORMAT:
If you find a clear match, respond with ONLY the exact database name in quotes.
If you find multiple good matches, list them separated by commas.
If no clear match exists, respond with "NO_MATCH".

Examples:
- Search: "wine" → "Wine Cellar Collection"
- Search: "stocks" → "Stock Analysis", "Investment Portfolio"  
- Search: "audio" → "Home Theater Systems"
- Search: "random" → NO_MATCH`;

      const response = await llm.create('limitless', {
        profile: 'bulk_structured',
        task_type: 'notion_database_match',
        workflow_name: 'lifelog_processing',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      });

      const aiResponse = (response.text || '').trim();
      
      if (aiResponse === 'NO_MATCH') {
        console.log('🤖 AI found no clear matches');
        return [];
      }

      // Parse AI response to extract database names
      const matchedNames = aiResponse
        .split(',')
        .map(name => name.trim().replace(/^"|"$/g, ''))
        .filter(name => name.length > 0);

      // Find the actual database objects that match the AI-identified names
      const matches = databases.filter(db => 
        matchedNames.some(matchedName => 
          db.title.toLowerCase() === matchedName.toLowerCase() ||
          db.title.toLowerCase().includes(matchedName.toLowerCase()) ||
          matchedName.toLowerCase().includes(db.title.toLowerCase())
        )
      );

      if (matches.length > 0) {
        console.log(`🤖 AI heuristic found ${matches.length} matches: ${matches.map(m => m.title).join(', ')}`);
      }

      return matches;

    } catch (error) {
      console.error('AI heuristic matching error:', error);
      return []; // Fail gracefully
    }
  }

  async addSchemaToResults(databases) {
    const results = [];
    
    for (const db of databases) {
      try {
        // Retrieve the full database schema
        const databaseDetails = await this.notion.databases.retrieve({ 
          database_id: db.id 
        });
        
        // Format schema for agent consumption
        const schema = this.formatSchemaForAgent(databaseDetails.properties);
        
        results.push({
          ...db,
          schema: schema,
          schema_description: this.generateSchemaDescription(schema)
        });
        
      } catch (error) {
        console.error(`Error retrieving schema for database ${db.id}:`, error);
        // Include database without schema if retrieval fails
        results.push({
          ...db,
          schema: null,
          schema_description: 'Schema unavailable'
        });
      }
    }
    
    return results;
  }

  formatSchemaForAgent(properties) {
    const schema = {};
    
    for (const [columnName, config] of Object.entries(properties)) {
      const columnType = config.type;
      
      schema[columnName] = {
        type: columnType,
        required: columnName === Object.keys(properties)[0], // First column (title) is usually required
        ...(this.getColumnDetails(config, columnType))
      };
    }
    
    return schema;
  }
  
  getColumnDetails(config, type) {
    const details = {};
    
    switch (type) {
      case 'select':
        details.options = config.select?.options?.map(opt => opt.name) || [];
        break;
      case 'multi_select':
        details.options = config.multi_select?.options?.map(opt => opt.name) || [];
        break;
      case 'number':
        details.format = config.number?.format || 'number';
        break;
      case 'date':
        details.include_time = config.date?.include_time || false;
        break;
      case 'checkbox':
        details.default = false;
        break;
      case 'files':
        details.accepts = 'Any file type (images, PDFs, documents, etc.)';
        details.format_example = 'File path, URL, or file object with name and external URL';
        break;
    }
    
    return details;
  }
  
  generateSchemaDescription(schema) {
    const columns = Object.entries(schema).map(([name, config]) => {
      let desc = `${name} (${config.type})`;
      if (config.options) desc += ` - Options: ${config.options.join(', ')}`;
      if (config.required) desc += ' *required*';
      return desc;
    });
    
    return `Columns: ${columns.join(' | ')}`;
  }

  async addToDatabase({ database_id, row_data, subject = '', context = '' }) {
    try {
      console.log(`📝 Adding row to database ${database_id}`);
      console.log(`📊 Row data from Claude:`, JSON.stringify(row_data, null, 2));

      // First, get the actual database schema to compare
      const database = await this.notion.databases.retrieve({ database_id });
      const actualSchema = database.properties;
      
      console.log(`🏗️  ACTUAL DATABASE SCHEMA:`);
      console.log(`   Database: ${database.title[0]?.text?.content || 'Unknown'}`);
      console.log(`   Columns: ${Object.keys(actualSchema).join(', ')}`);
      
      console.log(`❌ SCHEMA MISMATCH DETECTED:`);
      console.log(`   Claude sent: ${Object.keys(row_data).join(', ')}`);
      console.log(`   Database has: ${Object.keys(actualSchema).join(', ')}`);
      
      const missingColumns = Object.keys(row_data).filter(col => !actualSchema[col]);
      const availableColumns = Object.keys(actualSchema);
      
      console.log(`🚫 Missing columns in database: ${missingColumns.join(', ')}`);
      console.log(`✅ Available columns in database: ${availableColumns.join(', ')}`);

      // Convert row_data to Notion properties format using schema
      const notionProperties = this.convertRowDataToNotionFormat(row_data, actualSchema);
      console.log(`🔄 Converted to Notion format:`, JSON.stringify(notionProperties, null, 2));

      // Create page in database
      const response = await this.notion.pages.create({
        parent: { database_id },
        properties: notionProperties
      });

      const subjectInfo = subject ? ` "${subject}"` : '';
      return {
        success: true,
        page_id: response.id,
        page_url: response.url,
        message: `Added${subjectInfo} to database`,
        row_data_received: row_data
      };

    } catch (error) {
      console.error('Notion add to database error:', error);
      return {
        success: false,
        error: error.message,
        row_data_attempted: row_data
      };
    }
  }

  convertRowDataToNotionFormat(rowData, schema = null) {
    const notionProperties = {};
    
    for (const [columnName, value] of Object.entries(rowData)) {
      if (value === null || value === undefined || value === '') {
        continue; // Skip empty values
      }

      // Convert based on value type, content, and schema
      notionProperties[columnName] = this.formatValueForNotion(value, columnName, schema?.[columnName]);
    }
    
    return notionProperties;
  }

  formatValueForNotion(value, columnName, columnSchema = null) {
    // If value is already in Notion format, return as-is
    if (value && typeof value === 'object' && (value.title || value.rich_text || value.number || value.select || value.date || value.checkbox || value.multi_select || value.url || value.files)) {
      return value;
    }

    // Schema-aware formatting - check actual column type first
    if (columnSchema) {
      const columnType = columnSchema.type;
      
      console.log(`🔍 Formatting "${columnName}" (${columnType}): "${value}"`);
      
      switch (columnType) {
        case 'title':
          return {
            title: [{ type: 'text', text: { content: String(value) } }]
          };
          
        case 'rich_text':
          return {
            rich_text: [{ type: 'text', text: { content: String(value) } }]
          };
          
        case 'number':
          return { number: parseFloat(value) };
          
        case 'checkbox':
          return { checkbox: Boolean(value) };
          
        case 'date':
          return { date: { start: this.isDateString(value) ? value : new Date(value).toISOString().split('T')[0] } };
          
        case 'url':
          return { url: String(value) };
          
        case 'select':
          // Check if value is in the available options
          const selectOptions = columnSchema.select?.options?.map(opt => opt.name) || [];
          console.log(`🎯 Select options for "${columnName}": ${selectOptions.join(', ')}`);
          
          if (selectOptions.includes(String(value))) {
            console.log(`✅ "${value}" is valid select option for "${columnName}"`);
            return { select: { name: String(value) } };
          } else {
            console.log(`❌ "${value}" not in select options for "${columnName}". Using as rich_text.`);
            return { rich_text: [{ type: 'text', text: { content: String(value) } }] };
          }
          
        case 'multi_select':
          const multiSelectOptions = columnSchema.multi_select?.options?.map(opt => opt.name) || [];
          const values = Array.isArray(value) ? value : [value];
          const validValues = values.filter(v => multiSelectOptions.includes(String(v)));
          
          if (validValues.length > 0) {
            return {
              multi_select: validValues.map(v => ({ name: String(v) }))
            };
          } else {
            return { rich_text: [{ type: 'text', text: { content: String(value) } }] };
          }
          
        case 'files':
          return this.formatFileValue(value);
      }
    }

    // Fallback: Auto-detect format based on value content and column name
    
    // Files (detect file paths, URLs to files, or file objects)
    if (this.isFileValue(value, columnName)) {
      return this.formatFileValue(value);
    }
    
    // Title field (usually first column)
    if (columnName.toLowerCase().includes('name') || columnName.toLowerCase().includes('title') || columnName.toLowerCase() === 'wine' || columnName.toLowerCase() === 'company' || columnName.toLowerCase() === 'symbol') {
      return {
        title: [{ type: 'text', text: { content: String(value) } }]
      };
    }
    
    // Checkbox
    if (typeof value === 'boolean') {
      return { checkbox: value };
    }
    
    // Number
    if (typeof value === 'number' || (!isNaN(parseFloat(value)) && isFinite(value))) {
      return { number: parseFloat(value) };
    }
    
    // Date
    if (this.isDateString(value)) {
      return { date: { start: value } };
    }
    
    // Select (if value matches common select patterns)
    if (this.isSelectValue(value)) {
      return { select: { name: String(value) } };
    }
    
    // URL
    if (this.isUrl(value)) {
      return { url: String(value) };
    }
    
    // Default to rich_text
    return {
      rich_text: [{ type: 'text', text: { content: String(value) } }]
    };
  }

  isDateString(value) {
    if (!value) return false;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    return dateRegex.test(value) || !isNaN(Date.parse(value));
  }

  isSelectValue(value) {
    const selectPatterns = [
      'BUY', 'SELL', 'HOLD', 'USE', 'STORE', 'AVOID',
      'High', 'Medium', 'Low',
      'Good', 'At Par', 'Below Average',
      'Active', 'Monitoring', 'Completed',
      'DRINK NOW', 'CELLAR', 'GIFT'
    ];
    return selectPatterns.includes(String(value));
  }

  isUrl(value) {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }

  isFileValue(value, columnName) {
    // Check if column name suggests file content
    const fileColumnNames = ['file', 'attachment', 'document', 'image', 'pdf', 'report', 'photo', 'screenshot'];
    const isFileColumn = fileColumnNames.some(name => 
      columnName.toLowerCase().includes(name)
    );
    
    if (!isFileColumn) return false;
    
    // Check if value looks like a file
    if (typeof value === 'string') {
      // File path or URL to file
      return this.isFilePath(value) || this.isFileUrl(value);
    }
    
    // File object format
    if (typeof value === 'object' && value !== null) {
      return value.name || value.url || value.external;
    }
    
    return false;
  }

  isFilePath(value) {
    // Common file extensions
    const fileExtensions = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|jpg|jpeg|png|gif|svg|mp4|mp3|zip|csv|txt|md)$/i;
    return fileExtensions.test(value) || value.includes('/') || value.includes('\\');
  }

  isFileUrl(value) {
    if (!this.isUrl(value)) return false;
    
    // Check if URL points to a file
    const fileExtensions = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|jpg|jpeg|png|gif|svg|mp4|mp3|zip|csv|txt|md)(\?|$)/i;
    return fileExtensions.test(value) || 
           value.includes('drive.google.com') ||
           value.includes('dropbox.com') ||
           value.includes('onedrive.live.com') ||
           value.includes('amazonaws.com');
  }

  formatFileValue(value) {
    // Handle different file input formats
    
    // String: file path or URL
    if (typeof value === 'string') {
      const fileName = this.extractFileName(value);
      
      if (this.isUrl(value)) {
        // External URL
        return {
          files: [{
            type: 'external',
            name: fileName,
            external: {
              url: value
            }
          }]
        };
      } else {
        // Local file path - in reality, this would need to be uploaded
        // For now, treat as external with file path as name
        console.warn(`File path "${value}" needs to be uploaded to external storage first`);
        return {
          files: [{
            type: 'external', 
            name: fileName,
            external: {
              url: value // This would be replaced with actual uploaded URL
            }
          }]
        };
      }
    }
    
    // Object: structured file information
    if (typeof value === 'object' && value !== null) {
      // Already in Notion file format
      if (value.type && (value.file || value.external)) {
        return { files: [value] };
      }
      
      // Simple object with name and URL
      if (value.name && value.url) {
        return {
          files: [{
            type: 'external',
            name: value.name,
            external: {
              url: value.url
            }
          }]
        };
      }
      
      // Handle external object format
      if (value.external && value.external.url) {
        return {
          files: [{
            type: 'external',
            name: value.name || this.extractFileName(value.external.url),
            external: {
              url: value.external.url
            }
          }]
        };
      }
    }
    
    // Fallback: convert to string
    return {
      rich_text: [{ type: 'text', text: { content: String(value) } }]
    };
  }

  extractFileName(filePath) {
    if (!filePath) return 'Unknown File';
    
    // Extract filename from path or URL
    const parts = filePath.split(/[/\\]/);
    const fileName = parts[parts.length - 1];
    
    // Remove query parameters from URL
    return fileName.split('?')[0] || 'Unknown File';
  }

  async generateDataForSubject(subject, properties, context) {
    const data = {};
    
    // Simple data generation - in a full implementation, 
    // this would use AI to research and generate structured data
    for (const [propName, propConfig] of Object.entries(properties)) {
      switch (propConfig.type) {
        case 'title':
          data[propName] = {
            title: [{ type: 'text', text: { content: subject } }]
          };
          break;
        case 'rich_text':
          if (propName.toLowerCase().includes('note')) {
            data[propName] = {
              rich_text: [{ type: 'text', text: { content: context || 'Added via agent' } }]
            };
          }
          break;
        case 'date':
          if (propName.toLowerCase().includes('date')) {
            data[propName] = {
              date: { start: new Date().toISOString().split('T')[0] }
            };
          }
          break;
        case 'number':
          // Would normally research real values
          if (propName.toLowerCase().includes('price')) {
            data[propName] = { number: 100 }; // Placeholder
          } else if (propName.toLowerCase().includes('rating')) {
            data[propName] = { number: 4.0 }; // Placeholder
          }
          break;
      }
    }

    return data;
  }
}

module.exports = NotionMCP;
