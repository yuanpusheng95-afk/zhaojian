export class MockImageProvider {
  async generate({ generation }) {
    return [
      {
        candidateId: `candidate_${generation.id}`,
        assetId: `asset_${generation.id}`,
        verification: {
          identity: { status: 'pass', score: 1 },
          backgroundPreserved: { status: 'pass' },
        },
      },
    ];
  }
}
