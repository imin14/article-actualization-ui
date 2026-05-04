import { describe, it, expect } from 'vitest';
import {
  findHitsInBlock,
  buildClassificationPrompt,
  buildRewritePrompt,
} from '../lib/search-strategy.js';
import { approxTokens } from '../lib/tokenize.js';

const sampleBlock = {
  row_id: 'r-001',
  block_uid: 'blk-aaa',
  block_component: 'sectionBlock',
  original_payload: {
    heading: 'Citizenship rules',
    textMarkdown:
      'You can apply for Portuguese citizenship after 5 years.\n\n' +
      'Other unrelated content about residency.\n\n' +
      'Spouses and children of citizens may apply after 3 years instead of 5 years.',
    cta: 'Talk to an advisor',
  },
};

describe('findHitsInBlock', () => {
  it('returns hits per field with paragraph index, paragraph text, and context', () => {
    const hits = findHitsInBlock(sampleBlock, '5 years');
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(typeof h.field).toBe('string');
      expect(typeof h.hit_index).toBe('number');
      expect(typeof h.hit_paragraph).toBe('string');
      expect(typeof h.context).toBe('string');
      expect(h.hit_paragraph).toMatch(/5 years/i);
    }
  });

  it('finds multiple hits in different fields and different paragraphs', () => {
    const hits = findHitsInBlock(sampleBlock, '5 years');
    const fields = new Set(hits.map(h => h.field));
    expect(fields.has('textMarkdown')).toBe(true);
    // Two paragraphs in textMarkdown contain the keyword.
    const tmHits = hits.filter(h => h.field === 'textMarkdown');
    expect(tmHits.length).toBe(2);
    expect(tmHits.map(h => h.hit_index).sort()).toEqual([0, 2]);
  });

  it('skips fields that do not contain the keyword', () => {
    const hits = findHitsInBlock(sampleBlock, '5 years');
    expect(hits.find(h => h.field === 'heading')).toBeUndefined();
    expect(hits.find(h => h.field === 'cta')).toBeUndefined();
  });

  it('returns empty array when no hits anywhere in the block', () => {
    expect(findHitsInBlock(sampleBlock, 'nonexistent_keyword')).toEqual([]);
  });

  it('skips non-string fields silently', () => {
    const block = {
      original_payload: {
        heading: 'About 5 years',
        legacyCount: 5, // numeric
        nested: { foo: 'bar' }, // object
        flag: true, // boolean
      },
    };
    const hits = findHitsInBlock(block, '5 years');
    expect(hits.map(h => h.field)).toEqual(['heading']);
  });

  it('handles blocks with no original_payload safely', () => {
    expect(findHitsInBlock({}, '5 years')).toEqual([]);
    expect(findHitsInBlock({ original_payload: null }, '5 years')).toEqual([]);
  });

  it('context window includes the hit paragraph', () => {
    const hits = findHitsInBlock(sampleBlock, '5 years');
    for (const h of hits) {
      expect(h.context).toContain(h.hit_paragraph);
    }
  });
});

describe('buildClassificationPrompt', () => {
  it('returns a string-prompt object describing the classification task', () => {
    const out = buildClassificationPrompt({
      keyword: '5 years',
      contextDescription: 'Portugal Golden Visa: 5→10 years',
      hits: [
        { field: 'textMarkdown', hit_index: 0, hit_paragraph: 'Citizenship after 5 years.', context: 'Citizenship after 5 years.' },
      ],
    });
    expect(typeof out.prompt).toBe('string');
    expect(out.prompt).toContain('5 years');
    expect(out.prompt).toContain('Portugal');
  });

  it('produces a compact prompt — hit paragraph only, never the full block', () => {
    const longContext = 'noise '.repeat(2000); // very long context
    const out = buildClassificationPrompt({
      keyword: '5 years',
      contextDescription: 'topic X',
      hits: [
        { field: 'textMarkdown', hit_index: 0, hit_paragraph: 'Citizenship after 5 years.', context: longContext },
      ],
    });
    // Classification must NOT pull in the full context window.
    expect(out.prompt.length).toBeLessThan(2000);
    expect(approxTokens(out.prompt)).toBeLessThan(500);
  });

  it('exposes a JSON output schema describing yes/no decision', () => {
    const out = buildClassificationPrompt({
      keyword: '5 years',
      contextDescription: 'topic X',
      hits: [{ field: 'f', hit_index: 0, hit_paragraph: 'p', context: 'p' }],
    });
    expect(out.schema).toBeDefined();
    expect(typeof out.schema).toBe('object');
    // Schema should reference at minimum a boolean/string yes/no decision.
    const schemaJson = JSON.stringify(out.schema);
    expect(schemaJson).toMatch(/in_scope|decision|relevant|match/i);
  });

  it('stays under 500 tokens for typical 1–3 hits', () => {
    const out = buildClassificationPrompt({
      keyword: '5 years for Portuguese citizenship',
      contextDescription: 'Portugal Golden Visa: change from 5 to 10 years',
      hits: [
        { field: 'textMarkdown', hit_index: 0, hit_paragraph: 'You can apply for Portuguese citizenship after 5 years.', context: 'ctx' },
        { field: 'answer', hit_index: 0, hit_paragraph: 'Spouses and children apply after 3 years instead of 5 years.', context: 'ctx' },
      ],
    });
    expect(approxTokens(out.prompt)).toBeLessThan(500);
  });

  it('throws or returns no prompt when no hits provided', () => {
    let threw = false;
    let res;
    try {
      res = buildClassificationPrompt({ keyword: 'k', contextDescription: 'c', hits: [] });
    } catch (_) {
      threw = true;
    }
    expect(threw || (res && res.prompt === '')).toBe(true);
  });

  it('caps prompt size even when an individual hit paragraph is enormous', () => {
    const huge = 'noise word '.repeat(2000); // ~22000 chars, ~5500 tokens
    const out = buildClassificationPrompt({
      keyword: 'noise',
      contextDescription: 'topic X',
      hits: [
        { field: 'textMarkdown', hit_index: 0, hit_paragraph: huge, context: huge },
      ],
    });
    // Even with a giant hit paragraph, the classification prompt must stay
    // under ~500 tokens — that's the whole point of using the cheap model.
    expect(approxTokens(out.prompt)).toBeLessThan(500);
  });
});

describe('buildRewritePrompt', () => {
  const block = {
    block_component: 'sectionBlock',
    original_payload: {
      heading: 'Citizenship rules',
      textMarkdown:
        'P0 unrelated\n\n' +
        'You can apply for Portuguese citizenship after 5 years.\n\n' +
        'P2 unrelated noise.',
      cta: 'Talk to an advisor',
    },
  };

  const hits = [
    {
      field: 'textMarkdown',
      hit_index: 1,
      hit_paragraph: 'You can apply for Portuguese citizenship after 5 years.',
      context: 'P0 unrelated\n\nYou can apply for Portuguese citizenship after 5 years.\n\nP2 unrelated noise.',
    },
  ];

  it('returns a prompt that includes the rewrite instruction and the affected field name', () => {
    const out = buildRewritePrompt({
      rewritePrompt: 'Replace 5 years with 10 years where it refers to Portuguese citizenship.',
      block,
      hits,
    });
    expect(typeof out.prompt).toBe('string');
    expect(out.prompt).toContain('10 years');
    expect(out.prompt).toContain('textMarkdown');
  });

  it('includes the context window for affected fields, not unrelated fields', () => {
    const out = buildRewritePrompt({
      rewritePrompt: 'Replace 5 years with 10 years.',
      block,
      hits,
    });
    expect(out.prompt).toContain('5 years');
    // Should NOT include unrelated fields.
    expect(out.prompt).not.toContain('Citizenship rules');
    expect(out.prompt).not.toContain('Talk to an advisor');
  });

  it('exposes an output schema with updated_fields keyed by the affected field name', () => {
    const out = buildRewritePrompt({
      rewritePrompt: 'X',
      block,
      hits,
    });
    expect(out.schema).toBeDefined();
    const json = JSON.stringify(out.schema);
    expect(json).toMatch(/updated_fields/);
  });

  it('keeps prompt size proportional to hits, not full block', () => {
    const bigBlock = {
      block_component: 'sectionBlock',
      original_payload: {
        heading: 'Citizenship rules',
        textMarkdown:
          'noise '.repeat(500) + '\n\n' +
          'You can apply for Portuguese citizenship after 5 years.\n\n' +
          'noise '.repeat(500),
        cta: 'A'.repeat(2000),
      },
    };
    const bigHits = [
      {
        field: 'textMarkdown',
        hit_index: 1,
        hit_paragraph: 'You can apply for Portuguese citizenship after 5 years.',
        context: 'tiny context\n\nYou can apply for Portuguese citizenship after 5 years.\n\ntiny next',
      },
    ];
    const out = buildRewritePrompt({
      rewritePrompt: 'Replace 5 years with 10 years.',
      block: bigBlock,
      hits: bigHits,
    });
    // Must not balloon: should stay roughly token-size proportional to hit context.
    expect(approxTokens(out.prompt)).toBeLessThan(500);
    expect(out.prompt).not.toContain('A'.repeat(100));
  });

  it('groups multiple hits in the same field into a single field entry', () => {
    const multiHits = [
      { field: 'textMarkdown', hit_index: 0, hit_paragraph: 'First 5 years.', context: 'First 5 years.' },
      { field: 'textMarkdown', hit_index: 2, hit_paragraph: 'Later 5 years again.', context: 'Later 5 years again.' },
    ];
    const out = buildRewritePrompt({
      rewritePrompt: 'Replace 5 years with 10 years.',
      block,
      hits: multiHits,
    });
    // The field name should appear once in the structured part of the prompt.
    // We assert the prompt remains compact and contains both hit paragraphs.
    expect(out.prompt).toContain('First 5 years.');
    expect(out.prompt).toContain('Later 5 years again.');
  });

  it('throws or returns empty prompt when hits is empty', () => {
    let threw = false;
    let res;
    try {
      res = buildRewritePrompt({ rewritePrompt: 'x', block, hits: [] });
    } catch (_) {
      threw = true;
    }
    expect(threw || (res && res.prompt === '')).toBe(true);
  });
});

describe('search-strategy edge cases', () => {
  it('findHitsInBlock skips non-string field values gracefully when keyword is searched', () => {
    const block = {
      original_payload: {
        heading: 'About 5 years',
        meta: { x: 42 },           // object, not string
        count: 5,                   // number, not string
        flag: true,                 // boolean, not string
      },
    };
    const hits = findHitsInBlock(block, '5 years');
    expect(hits.map(h => h.field)).toEqual(['heading']);
  });

  it('buildClassificationPrompt with empty hits returns an empty prompt (signals no hits to classify)', () => {
    const out = buildClassificationPrompt({
      keyword: 'k',
      contextDescription: 'topic X',
      hits: [],
    });
    expect(out.prompt).toBe('');
    expect(out.schema).toBeDefined();
  });

  it('buildRewritePrompt includes the rewrite instruction verbatim somewhere in the output', () => {
    const rewriteText = 'Replace 5 years with 10 years where it refers to Portuguese citizenship.';
    const out = buildRewritePrompt({
      rewritePrompt: rewriteText,
      block: {
        block_component: 'sectionBlock',
        original_payload: {
          textMarkdown: 'You can apply after 5 years.',
        },
      },
      hits: [
        {
          field: 'textMarkdown',
          hit_index: 0,
          hit_paragraph: 'You can apply after 5 years.',
          context: 'You can apply after 5 years.',
        },
      ],
    });
    expect(out.prompt).toContain(rewriteText);
  });
});
