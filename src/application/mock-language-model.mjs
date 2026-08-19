export class MockLanguageModel {
  capability = 'language';
  #planner;

  constructor({ planner }) {
    if (typeof planner !== 'function') {
      throw new TypeError(
        'Mock language model requires a planner function',
      );
    }
    this.#planner = planner;
  }

  async planPatch(input) {
    const patch = await this.#planner(input);
    return structuredClone(patch);
  }
}
