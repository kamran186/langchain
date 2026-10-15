# Employee memory search flowcharts

Every `POST /api/chat` turn loads all three memory types before the agent runs. Every PostgreSQL memory query is scoped by both `organizationId` and `employeeId`. The stored `userId` and `threadId` identify a memory's source but do not restrict employee-wide recall. Each category returns at most `MEMORY_LIMIT` records (default: five).

The diagrams follow the current implementation. `memoriesUsed` in the chat response contains records actually supplied to the model, which can differ from records loaded from PostgreSQL.

## Semantic memory: reusable facts

![Semantic memory search flowchart](images/semantic-memory-search.png)

```mermaid
flowchart TD
    userPrompt["User asks about Ahmed Khan"] --> apiScope["API validates request IDs"]
    apiScope --> loadNode["LangGraph: loadMemories"]
    loadNode --> semanticDb[("PostgreSQL: semantic memories scoped to organization and employee")]
    semanticDb --> semanticRank["Memory: rank by text relevance, then recency; take top 5 by default"]
    semanticRank --> semanticContext["LangChain: supply retrieved facts as lower-priority context"]
    semanticContext --> semanticAgent["LLM Agent: answer or request current customer data"]
    semanticAgent --> needsTool{"Customer tool requested?"}
    needsTool -- Yes --> customerTool["LangChain: execute get_customers and return actual results"]
    customerTool --> semanticAgent
    needsTool -- No --> semanticFinal["LLM Agent: final answer"]
    semanticFinal --> explicitFact{"Current prompt explicitly states a reusable fact?"}
    explicitFact -- Yes --> semanticSave["Memory: upsert fact and save episode in one transaction"]
    explicitFact -- No --> semanticEpisode["Memory: save completed interaction episode"]
    semanticSave --> semanticResponse["API: return response and memoriesUsed.semantic"]
    semanticEpisode --> semanticResponse
    classDef graphNode fill:#dbeafe,stroke:#2563eb,color:#172554
    classDef memoryNode fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef chainNode fill:#cffafe,stroke:#0891b2,color:#164e63
    classDef agentNode fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef dataNode fill:#f3e8ff,stroke:#9333ea,color:#581c87
    class loadNode graphNode
    class semanticRank,semanticSave,semanticEpisode memoryNode
    class semanticContext,customerTool chainNode
    class semanticAgent,semanticFinal agentNode
    class semanticDb dataNode
```

Example: `Remember that Ahmed Khan works at SalesTeq in the IT industry.` saves a semantic fact after that response completes. A later thread can retrieve it when asking about Ahmed Khan. A question about the fact does not create another semantic fact.

## Episodic memory: previous interactions

![Episodic memory search flowchart](images/episodic-memory-search.png)

```mermaid
flowchart TD
    userPrompt["User asks about a previous customer search"] --> loadNode["LangGraph: loadMemories"]
    loadNode --> episodeDb[("PostgreSQL: episodes scoped to organization and employee")]
    episodeDb --> episodeRank["Memory: rank by text relevance, then recency; take top 5 by default"]
    episodeRank --> planningContext["LangChain: supply applicable episodes to LLM Agent"]
    planningContext --> episodeAgent["LLM Agent: answer or request customer data"]
    episodeAgent --> needsTool{"Customer tool requested?"}
    needsTool -- Yes --> customerTool["LangChain: execute get_customers and record filters and outcome"]
    customerTool --> finalWithTool["LLM Agent: receive tool result and loaded episodes"]
    needsTool -- No --> finalWithoutTool["LLM Agent: final answer from supplied context"]
    finalWithTool --> episodeSave["Memory: build episode from actual request and tool evidence"]
    finalWithoutTool --> episodeSave
    episodeSave --> episodeDbWrite[("PostgreSQL: save episode with source userId and threadId")]
    episodeDbWrite --> episodeResponse["API: return response and memoriesUsed.episodic"]
    classDef graphNode fill:#dbeafe,stroke:#2563eb,color:#172554
    classDef memoryNode fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef chainNode fill:#cffafe,stroke:#0891b2,color:#164e63
    classDef agentNode fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef dataNode fill:#f3e8ff,stroke:#9333ea,color:#581c87
    class loadNode graphNode
    class episodeRank,episodeSave memoryNode
    class planningContext,customerTool chainNode
    class episodeAgent,finalWithTool,finalWithoutTool agentNode
    class episodeDb,episodeDbWrite dataNode
```

For a normal customer request, episodes created by standalone procedure instructions are excluded from initial customer lookup planning. After a tool call, the loaded episodes can be supplied for the final answer. An episode is saved only after a final response, and its outcome distinguishes real results, no matches, and tool failure. The turn ID prevents a retried save from duplicating that episode.

## Procedural memory: reusable instructions and preferences

![Procedural memory search flowchart](images/procedural-memory-search.png)

```mermaid
flowchart TD
    userPrompt["User sends prompt"] --> loadNode["LangGraph: loadMemories"]
    loadNode --> procedureDb[("PostgreSQL: procedures scoped to organization and employee")]
    procedureDb --> recentProcedures["Memory: load most recent procedures; top 5 by default"]
    recentProcedures --> instructionOnly{"Explicit reusable instruction in current prompt?"}
    instructionOnly -- Yes --> instructionAgent["LLM Agent: receive procedures and answer without customer tool"]
    instructionAgent --> upsertProcedure["Memory: upsert procedure and save episode in one transaction"]
    instructionOnly -- No --> lookupAgent["LLM Agent: plan customer lookup without procedures"]
    lookupAgent --> needsTool{"Customer tool called?"}
    needsTool -- Yes --> customerTool["LangChain: execute get_customers with validated filters"]
    customerTool --> resultAgent["LLM Agent: receive tool result and procedures for final answer"]
    needsTool -- No --> noProcedureAgent["LLM Agent: final answer without procedures"]
    resultAgent --> saveEpisode["Memory: save completed interaction episode"]
    noProcedureAgent --> saveEpisode
    upsertProcedure --> procedureResponse
    saveEpisode --> procedureResponse["API: return response and memoriesUsed.procedural"]
    classDef graphNode fill:#dbeafe,stroke:#2563eb,color:#172554
    classDef memoryNode fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef chainNode fill:#cffafe,stroke:#0891b2,color:#164e63
    classDef agentNode fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef dataNode fill:#f3e8ff,stroke:#9333ea,color:#581c87
    class loadNode graphNode
    class recentProcedures,upsertProcedure,saveEpisode memoryNode
    class customerTool chainNode
    class instructionAgent,lookupAgent,resultAgent,noProcedureAgent agentNode
    class procedureDb dataNode
```

Example: `Always display customer results in a table.` is saved as a procedure after a completed response. In a later customer lookup, the procedure is supplied when the agent formats the tool result. Presentation preferences are not added to `get_customers` filters. If a normal turn ends without a tool call, loaded procedures are not supplied to that turn's final model response.

For requests that exercise these paths, see [Memory cURL examples](memory-curl-examples.md).
