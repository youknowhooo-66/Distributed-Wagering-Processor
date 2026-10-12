import { describe, it, expect } from 'bun:test';

describe('Bunfig preload verification', () => {
  it('proves ENABLE_BACKGROUND_POLL is set to false by bunfig preload in direct bun test', () => {
    expect(process.env.ENABLE_BACKGROUND_POLL).toBe('false');
  });
});
