const { Router } = require('express');
const crypto = require('crypto');
const supabase = require('../lib/supabase');

const router = Router();

// GET / — fetch all alt_docs
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('alt_docs').select('*');

  if (error) return res.status(500).json({ error: error.message });

  res.json({ docs: data || [] });
});

// GET /blocks-test — fetch alt_blocks with optional filters
router.post('/generadas', async function (request, response) {
  const practicasIds = request.body.practicas_ids;

  // Validate the request body
  if (!practicasIds || !Array.isArray(practicasIds)) {
    return response.status(400).json({ error: 'practicas_ids must be an array' });
  }

  if (practicasIds.length === 0) {
    return response.json({ blocks: [] });
  }

  // ==========================================
  // SINGLE STEP: Fetch the Entire Tree
  // ==========================================
  // We query alt_docs as the root. The !inner join acts as a strict filter: 
  // "Only return this Document if it has a linked practice in our array."
  const { data: databaseTree, error: databaseError } = await supabase
    .from('alt_docs')
    .select(`
      id,
      alt_practicas_docs!inner(practica_id),
      alt_blocks (
        id,
        created_at,
        body,
        alt_blocktypes_id,
        alt_docs_id,
        order,
        alt_blocks_chips (
          alt_chips (
            id,
            content,
            override_list,
            override_order,
            comentario
          )
        )
      )
    `)
    .in('alt_practicas_docs.practica_id', practicasIds);

  if (databaseError) {
    return response.status(500).json({ error: databaseError.message });
  }

  // ==========================================
  // FLATTEN THE DATA
  // ==========================================
  // The database gives us: Docs -> Blocks -> Chips.
  // The frontend just wants: Blocks (with chips attached).
  const allExtractedBlocks = [];
  const safeDatabaseTree = databaseTree || [];

  safeDatabaseTree.forEach(function (document) {
    const documentBlocks = document.alt_blocks || [];

    documentBlocks.forEach(function (block) {
      const extractedChips = [];
      const rawBlockChips = block.alt_blocks_chips || [];

      // Extract the actual chip data out of the junction table wrapper
      rawBlockChips.forEach(function (junctionRow) {
        if (junctionRow.alt_chips) {
          extractedChips.push(junctionRow.alt_chips);
        }
      });

      // Push the clean block into our master list
      allExtractedBlocks.push({
        id: block.id,
        created_at: block.created_at,
        body: block.body,
        alt_blocktypes_id: block.alt_blocktypes_id,
        alt_docs_id: block.alt_docs_id,
        order: block.order,
        smart_chips: extractedChips
      });
    });
  });

  // Ensure the final flattened array is sorted by the 'order' column.
  // This is helpful because pulling blocks from multiple documents might jumble their sequence.
  allExtractedBlocks.sort(function (blockA, blockB) {
    const orderA = blockA.order || 0;
    const orderB = blockB.order || 0;
    return orderA - orderB;
  });

  return response.json({ blocks: allExtractedBlocks });
});

router.post('/generadas-v2', async function (request, response) {
  const practicasIds = request.body.practicas_ids;

  // Validate the request body
  if (!practicasIds || !Array.isArray(practicasIds)) {
    return response.status(400).json({ error: 'practicas_ids must be an array' });
  }

  if (practicasIds.length === 0) {
    return response.json({ docs: [], global_chips: {} });
  }

  // ==========================================
  // SINGLE STEP: Fetch the Entire Tree
  // ==========================================
  const { data: databaseTree, error: databaseError } = await supabase
    .from('alt_docs')
    .select(`
      id,
      alt_practicas_docs!inner(practica_id),
      alt_blocks (
        id,
        created_at,
        body,
        alt_blocktypes_id,
        alt_docs_id,
        order,
        alt_blocks_chips (
          alt_chips (
            id,
            content,
            override_list,
            override_order,
            comentario
          )
        )
      )
    `)
    .in('alt_practicas_docs.practica_id', practicasIds);

  if (databaseError) {
    return response.status(500).json({ error: databaseError.message });
  }

  // ==========================================
  // PROCESS AND GROUP THE DATA
  // ==========================================
  const finalDocs = [];
  const globalUniqueChipsMap = new Map();
  const safeDatabaseTree = databaseTree || [];

  // Loop through every document
  safeDatabaseTree.forEach(function (document) {
    const documentBlocks = [];
    const rawBlocks = document.alt_blocks || [];

    // Loop through every block inside the current document
    rawBlocks.forEach(function (block) {
      const blockChips = [];
      const rawBlockChips = block.alt_blocks_chips || [];

      // Extract chips and add them to both the block and the global tracker
      rawBlockChips.forEach(function (junctionRow) {
        if (junctionRow.alt_chips) {
          const chip = junctionRow.alt_chips;

          // 1. Add the chip to this specific block's array
          blockChips.push(chip);

          // 2. Add the chip to our global tracking map (using its ID to ensure no duplicates)
          if (!globalUniqueChipsMap.has(chip.id)) {
            globalUniqueChipsMap.set(chip.id, chip);
          }
        }
      });

      documentBlocks.push({
        id: block.id,
        created_at: block.created_at,
        body: block.body,
        alt_blocktypes_id: block.alt_blocktypes_id,
        alt_docs_id: document.id,
        order: block.order,
        smart_chips: blockChips
      });
    });

    // Sort the blocks sequentially before attaching them to the document
    documentBlocks.sort(function (blockA, blockB) {
      const orderA = blockA.order || 0;
      const orderB = blockB.order || 0;
      return orderA - orderB;
    });

    // Push the structured document into the final array
    finalDocs.push({
      id: document.id,
      blocks: documentBlocks
    });
  });

  // ==========================================
  // ORGANIZE GLOBAL CHIPS
  // ==========================================
  const groupedGlobalChips = {};
  const allUniqueChipsArray = Array.from(globalUniqueChipsMap.values());

  // Group all unique chips by their override_list ID
  allUniqueChipsArray.forEach(function (chip) {
    // If a chip has no list assigned, we group it under 'unlisted'
    const listId = chip.override_list !== null && chip.override_list !== undefined
      ? String(chip.override_list)
      : 'unlisted';

    if (!groupedGlobalChips[listId]) {
      groupedGlobalChips[listId] = [];
    }

    groupedGlobalChips[listId].push(chip);
  });

  // Sort each group by override_order to establish priority
  Object.keys(groupedGlobalChips).forEach(function (listId) {
    groupedGlobalChips[listId].sort(function (chipA, chipB) {
      const orderA = chipA.override_order || 0;
      const orderB = chipB.override_order || 0;

      // Note: This sorts ascending (1, 2, 3). 
      // If a higher number means higher priority in your system (e.g., 9 is better than 1),
      // change this to: return orderB - orderA;
      return orderA - orderB;
    });
  });

  // ==========================================
  // FINAL PAYLOAD
  // ==========================================
  return response.json({
    docs: finalDocs,
    global_chips: groupedGlobalChips
  });
});


router.post('/generadas-v3', async function (request, response) {
  const practicasIds = request.body.practicas_ids;

  // Validate the request body
  if (!practicasIds || !Array.isArray(practicasIds)) {
    return response.status(400).json({ error: 'practicas_ids must be an array' });
  }

  if (practicasIds.length === 0) {
    return response.json({ docs: [], global_chips: {} });
  }

  // ==========================================
  // DATABASE QUERY: Fetch the Entire Tree
  // ==========================================
  const { data: databaseTree, error: databaseError } = await supabase
    .from('alt_docs')
    .select(`
      id,
      alt_practicas_docs!inner(practica_id),
      alt_blocks (
        id,
        created_at,
        body,
        alt_blocktypes_id,
        alt_docs_id,
        order,
        alt_blocks_chips (
          alt_chips (
            id,
            content,
            override_list,
            override_order,
            comentario
          )
        )
      )
    `)
    .in('alt_practicas_docs.practica_id', practicasIds);

  if (databaseError) {
    return response.status(500).json({ error: databaseError.message });
  }

  const safeDatabaseTree = databaseTree || [];

  // ==========================================
  // PASS 1: Extract and Sort Global Chips
  // ==========================================
  const globalUniqueChipsMap = new Map();
  const groupedGlobalChips = {};

  // 1a. Extract every unique chip into a Map
  safeDatabaseTree.forEach(function (document) {
    const rawBlocks = document.alt_blocks || [];
    rawBlocks.forEach(function (block) {
      const rawBlockChips = block.alt_blocks_chips || [];
      rawBlockChips.forEach(function (junctionRow) {
        if (junctionRow.alt_chips) {
          const chip = junctionRow.alt_chips;
          if (!globalUniqueChipsMap.has(chip.id)) {
            globalUniqueChipsMap.set(chip.id, chip);
          }
        }
      });
    });
  });

  // 1b. Group chips by override_list
  const allUniqueChipsArray = Array.from(globalUniqueChipsMap.values());
  allUniqueChipsArray.forEach(function (chip) {
    const listId = chip.override_list !== null && chip.override_list !== undefined
      ? String(chip.override_list)
      : 'unlisted';

    if (!groupedGlobalChips[listId]) {
      groupedGlobalChips[listId] = [];
    }
    groupedGlobalChips[listId].push(chip);
  });

  // 1c. Sort groups by override_order (ascending priority: 1 overrides 2)
  Object.keys(groupedGlobalChips).forEach(function (listId) {
    groupedGlobalChips[listId].sort(function (chipA, chipB) {
      const orderA = chipA.override_order || 0;
      const orderB = chipB.override_order || 0;
      return orderA - orderB;
    });
  });

  // ==========================================
  // PASS 2: Parse Body and Apply Overrides
  // ==========================================
  const finalDocs = [];

  // Regex to match placeholders like {5} or {{5}}
  const placeholderRegex = /\{\{?(\d+)\}?\}/g;

  safeDatabaseTree.forEach(function (document) {
    const finalBlocksArray = [];
    const finalResultTextArray = []; // Holds the fully resolved text for this document

    const rawBlocks = document.alt_blocks || [];

    // Sort blocks sequentially
    rawBlocks.sort(function (blockA, blockB) {
      return (blockA.order || 0) - (blockB.order || 0);
    });

    rawBlocks.forEach(function (block) {
      const parsedBody = [];
      let resolvedBlockText = "";
      let lastIndex = 0;
      let match;
      const blockBodyString = block.body || "";

      // Walk through the block's text finding every {id}
      while ((match = placeholderRegex.exec(blockBodyString)) !== null) {
        // 1. Capture the text BEFORE the placeholder
        const textBefore = blockBodyString.slice(lastIndex, match.index);
        if (textBefore) {
          parsedBody.push({ type: 'text', content: textBefore });
          resolvedBlockText += textBefore;
        }

        // 2. Identify the chip from the placeholder ID
        const chipId = parseInt(match[1], 10);
        const originalChip = globalUniqueChipsMap.get(chipId);

        if (originalChip) {
          // Push the original chip dictionary so the frontend knows what is structured here
          parsedBody.push({ type: 'smart_chip', content: originalChip });

          // Determine the "winning" chip based on our pre-sorted global groups
          const listId = originalChip.override_list !== null && originalChip.override_list !== undefined
            ? String(originalChip.override_list)
            : 'unlisted';

          const winningChip = groupedGlobalChips[listId][0];

          // Apply the winning chip's text to the final_result string
          resolvedBlockText += (winningChip.content || "");
        } else {
          // Fallback if a placeholder exists in text but the chip isn't in the database
          parsedBody.push({ type: 'text', content: match[0] });
          resolvedBlockText += match[0];
        }

        lastIndex = placeholderRegex.lastIndex;
      }

      // 3. Capture any remaining text AFTER the last placeholder
      const textAfter = blockBodyString.slice(lastIndex);
      if (textAfter) {
        parsedBody.push({ type: 'text', content: textAfter });
        resolvedBlockText += textAfter;
      }

      // Add the fully parsed block to the array
      finalBlocksArray.push({
        id: block.id,
        created_at: block.created_at,
        parsed_body: parsedBody,
        alt_blocktypes_id: block.alt_blocktypes_id,
        alt_docs_id: document.id,
        order: block.order
      });

      // Add the resolved text string to our document's final output array
      finalResultTextArray.push(resolvedBlockText);
    });

    // Push the complete document to the final output
    finalDocs.push({
      id: document.id,
      blocks: finalBlocksArray,
      final_result: finalResultTextArray
    });
  });

  // ==========================================
  // FINAL PAYLOAD
  // ==========================================
  return response.json({
    docs: finalDocs,
    global_chips: groupedGlobalChips
  });
});

router.post('/generadas-v4', async function (request, response) {
  const practicasIds = request.body.practicas_ids;

  // Validate the request body
  if (!practicasIds || !Array.isArray(practicasIds)) {
    return response.status(400).json({ error: 'practicas_ids must be an array' });
  }

  if (practicasIds.length === 0) {
    return response.json({ docs: [], global_chips: {} });
  }

  // ==========================================
  // DATABASE QUERY: Fetch the Entire Tree
  // ==========================================
  const { data: databaseTree, error: databaseError } = await supabase
    .from('alt_docs')
    .select(`
      id,
      alt_practicas_docs!inner(practica_id),
      alt_blocks (
        id,
        created_at,
        body,
        alt_blocktypes_id,
        alt_docs_id,
        order,
        alt_blocks_chips (
          alt_chips (
            id,
            content,
            override_list,
            override_order,
            comentario
          )
        )
      )
    `)
    .in('alt_practicas_docs.practica_id', practicasIds);

  if (databaseError) {
    return response.status(500).json({ error: databaseError.message });
  }

  const safeDatabaseTree = databaseTree || [];

  // ==========================================
  // PASS 1: Extract and Sort Global Chips
  // ==========================================
  const globalUniqueChipsMap = new Map();
  const groupedGlobalChips = {};
  let isOverriding = false;

  // 1a. Extract every unique chip into a Map
  safeDatabaseTree.forEach(function (document) {
    const rawBlocks = document.alt_blocks || [];
    rawBlocks.forEach(function (block) {
      const rawBlockChips = block.alt_blocks_chips || [];
      rawBlockChips.forEach(function (junctionRow) {
        if (junctionRow.alt_chips) {
          const chip = junctionRow.alt_chips;
          if (!globalUniqueChipsMap.has(chip.id)) {
            globalUniqueChipsMap.set(chip.id, chip);
          }
        }
      });
    });
  });

  // 1b. Group chips by override_list
  const allUniqueChipsArray = Array.from(globalUniqueChipsMap.values());
  allUniqueChipsArray.forEach(function (chip) {
    const listId = chip.override_list !== null && chip.override_list !== undefined
      ? String(chip.override_list)
      : 'unlisted';

    if (!groupedGlobalChips[listId]) {
      groupedGlobalChips[listId] = [];
    }
    groupedGlobalChips[listId].push(chip);
  });

  // 1c. Sort groups by override_order (ascending priority: 1 overrides 2)
  Object.keys(groupedGlobalChips).forEach(function (listId) {
    if (listId !== 'unlisted' && groupedGlobalChips[listId].length > 1) {
      isOverriding = true;
    }
    groupedGlobalChips[listId].sort(function (chipA, chipB) {
      const orderA = chipA.override_order || 0;
      const orderB = chipB.override_order || 0;
      return orderA - orderB;
    });
  });

  // ==========================================
  // PASS 2: Parse Body and Apply Overrides
  // ==========================================
  const finalDocs = [];
  const placeholderRegex = /\{\{?(\d+)\}?\}/g;
  const usedDocsIds = [];

  safeDatabaseTree.forEach(function (document) {
    const finalBlocksArray = [];
    const finalResultTextArray = []; 
    usedDocsIds.push(document.id);

    const rawBlocks = document.alt_blocks || [];
    rawBlocks.sort(function (blockA, blockB) {
      return (blockA.order || 0) - (blockB.order || 0);
    });

    rawBlocks.forEach(function (block) {
      const parsedBody = [];
      let resolvedBlockText = "";
      let lastIndex = 0;
      let match;
      const blockBodyString = block.body || "";

      while ((match = placeholderRegex.exec(blockBodyString)) !== null) {
        const textBefore = blockBodyString.slice(lastIndex, match.index);
        if (textBefore) {
          parsedBody.push({ type: 'text', content: textBefore });
          resolvedBlockText += textBefore;
        }

        const chipId = parseInt(match[1], 10);
        const originalChip = globalUniqueChipsMap.get(chipId);

        if (originalChip) {
          parsedBody.push({ type: 'smart_chip', content: originalChip });
          const listId = originalChip.override_list !== null && originalChip.override_list !== undefined
            ? String(originalChip.override_list)
            : 'unlisted';
          const winningChip = groupedGlobalChips[listId][0];
          resolvedBlockText += (winningChip.content || "");
        } else {
          parsedBody.push({ type: 'text', content: match[0] });
          resolvedBlockText += match[0];
        }

        lastIndex = placeholderRegex.lastIndex;
      }

      const textAfter = blockBodyString.slice(lastIndex);
      if (textAfter) {
        parsedBody.push({ type: 'text', content: textAfter });
        resolvedBlockText += textAfter;
      }

      finalBlocksArray.push({
        id: block.id,
        created_at: block.created_at,
        parsed_body: parsedBody,
        alt_blocktypes_id: block.alt_blocktypes_id,
        alt_docs_id: document.id,
        order: block.order
      });

      finalResultTextArray.push(resolvedBlockText);
    });

    finalDocs.push({
      id: document.id,
      blocks: finalBlocksArray,
      final_result: finalResultTextArray
    });
  });

  // ==========================================
  // AI MIXING LOGIC
  // ==========================================
  let aiMixedResponse = null;

  if (isOverriding && finalDocs.length > 0) {
    // deduplicate doc ids just in case, sort ascending
    const uniqueUsedDocsIds = [...new Set(usedDocsIds)].sort((a, b) => a - b);
    const hashId = crypto.createHash('sha256').update(uniqueUsedDocsIds.join(',')).digest('hex');

    const { data: cacheData, error: cacheError } = await supabase
      .from('alt_cache')
      .select('id, result')
      .eq('hashed_texts_ids', hashId)
      .single();

    if (cacheData && cacheData.result) {
      aiMixedResponse = {
        generated_text: cacheData.result,
        hashed_texts_ids: hashId,
        id: cacheData.id
      };
    } else {
      // Call Gemini AI
      const allDocsText = finalDocs.map(d => d.final_result.join('\n')).join('\n\n---\n\n');
      
      try {
        const systemPrompt = "You are a helpful assistant. Try to mix all the provided documents into one cohesive and organized document. Ensure no information is lost, but try to avoid repeating identical instructions or contradicting parts. Combine them logically.";
        
        const geminiPayload = {
          system_instruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [
            {
              parts: [
                { text: "Here are the documents to mix:\n\n" + allDocsText }
              ]
            }
          ]
        };

        const geminiResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-goog-api-key': process.env.GEMINI_API_KEY
          },
          body: JSON.stringify(geminiPayload)
        });

        if (geminiResponse.ok) {
          const geminiData = await geminiResponse.json();
          if (geminiData.candidates && geminiData.candidates.length > 0) {
            const aiMixedResultText = geminiData.candidates[0].content.parts[0].text;
            
            // Store in alt_cache
            const { data: insertData } = await supabase.from('alt_cache').insert({
              hashed_texts_ids: hashId,
              result: aiMixedResultText
            }).select('id').single();
            
            aiMixedResponse = {
              generated_text: aiMixedResultText,
              hashed_texts_ids: hashId,
              id: insertData ? insertData.id : null
            };
          }
        } else {
          console.error("Gemini API error:", await geminiResponse.text());
        }
      } catch (err) {
        console.error("Error calling Gemini API:", err);
      }
    }
  }

  // ==========================================
  // FINAL PAYLOAD
  // ==========================================
  return response.json({
    docs: finalDocs,
    global_chips: groupedGlobalChips,
    ai_mixed_result: aiMixedResponse
  });
});

module.exports = router;

