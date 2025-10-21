import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Pinecone } from "@pinecone-database/pinecone";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

// TypeScript interfaces for type safety
interface PineconeMetadata {
	problem_text: string;
	solution_text: string;
	timestamp: string;
	language?: string;
	framework?: string;
}

interface SearchResult {
	problem: string;
	solution: string;
	score: number;
	metadata: {
		language?: string;
		framework?: string;
		timestamp: string;
	};
}

// Constants
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 512;
const PINECONE_INDEX_NAME = "cleopatra";
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

// Define our MCP agent for agent knowledge sharing
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Agent Knowledge Base",
		version: "1.0.0",
	});

	private pinecone: Pinecone | null = null;
	private openai: OpenAI | null = null;
	private index: any = null;

	async init() {
		// Initialize clients (will be done lazily to access env)
		// Tools will initialize clients on first use

		// Tool 1: Upload - Store problem-solution pairs
		this.server.tool(
			"upload",
			"Upload a problem-solution pair to the knowledge base. Use this when you've successfully solved a bug or error to help other agents.",
			{
				problem: z.string().describe("Detailed description of the error, bug, or issue encountered"),
				solution: z.string().describe("The fix or resolution that successfully solved the problem"),
				language: z.string().optional().describe("Programming language (e.g., 'TypeScript', 'Python', 'JavaScript')"),
				framework: z.string().optional().describe("Framework or library (e.g., 'React', 'Express', 'Django')"),
			},
			async ({ problem, solution, language, framework }) => {
				try {
					// Initialize clients if not already done
					await this.initializeClients();

					// Generate embedding for the problem
					const embedding = await this.generateEmbedding(problem);

					// Create metadata object
					const metadata: PineconeMetadata = {
						problem_text: problem,
						solution_text: solution,
						timestamp: new Date().toISOString(),
						...(language && { language }),
						...(framework && { framework }),
					};

					// Generate unique ID
					const recordId = uuidv4();

					// Upsert to Pinecone
					await this.index.upsert([
						{
							id: recordId,
							values: embedding,
							metadata,
						},
					]);

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									status: "success",
									id: recordId,
									message: "Problem-solution pair successfully uploaded to the knowledge base",
								}),
							},
						],
					};
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									status: "error",
									message: `Failed to upload to knowledge base: ${errorMessage}`,
								}),
							},
						],
						isError: true,
					};
				}
			},
		);

		// Tool 2: Search - Find similar problems and solutions
		this.server.tool(
			"search",
			"Search the knowledge base for solutions to similar problems. Use this when you encounter an error or bug to find solutions from other agents.",
			{
				query: z.string().describe("Description of the problem, error, or bug you're trying to solve"),
				topK: z
					.number()
					.int()
					.min(1)
					.max(MAX_TOP_K)
					.optional()
					.describe(`Number of results to return (default: ${DEFAULT_TOP_K}, max: ${MAX_TOP_K})`),
			},
			async ({ query, topK = DEFAULT_TOP_K }) => {
				try {
					// Initialize clients if not already done
					await this.initializeClients();

					// Generate embedding for the query
					const embedding = await this.generateEmbedding(query);

					// Query Pinecone
					const queryResponse = await this.index.query({
						vector: embedding,
						topK: topK,
						includeMetadata: true,
					});

					// Format results
					const results: SearchResult[] = queryResponse.matches.map((match: any) => ({
						problem: match.metadata.problem_text,
						solution: match.metadata.solution_text,
						score: match.score,
						metadata: {
							language: match.metadata.language,
							framework: match.metadata.framework,
							timestamp: match.metadata.timestamp,
						},
					}));

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									status: "success",
									query: query,
									results_found: results.length,
									results: results,
								}),
							},
						],
					};
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									status: "error",
									message: `Failed to search knowledge base: ${errorMessage}`,
								}),
							},
						],
						isError: true,
					};
				}
			},
		);
	}

	// Helper method to initialize clients
	private async initializeClients() {
		if (!this.pinecone || !this.openai) {
			// Access environment variables from the Cloudflare Worker context
			const env = (this as any).env;

			if (!env.PINECONE_API_KEY) {
				throw new Error("PINECONE_API_KEY environment variable is not set");
			}
			if (!env.OPENAI_API_KEY) {
				throw new Error("OPENAI_API_KEY environment variable is not set");
			}
			if (!env.PINECONE_HOST) {
				throw new Error("PINECONE_HOST environment variable is not set");
			}

			// Initialize Pinecone client
			this.pinecone = new Pinecone({
				apiKey: env.PINECONE_API_KEY,
			});

			// Get the index
			this.index = this.pinecone.index(PINECONE_INDEX_NAME, env.PINECONE_HOST);

			// Initialize OpenAI client
			this.openai = new OpenAI({
				apiKey: env.OPENAI_API_KEY,
			});
		}
	}

	// Helper method to generate embeddings
	private async generateEmbedding(text: string): Promise<number[]> {
		if (!this.openai) {
			throw new Error("OpenAI client not initialized");
		}

		const response = await this.openai.embeddings.create({
			model: EMBEDDING_MODEL,
			input: text,
			dimensions: EMBEDDING_DIMENSIONS,
		});

		return response.data[0].embedding;
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
