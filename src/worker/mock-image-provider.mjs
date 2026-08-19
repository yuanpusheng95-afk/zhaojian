export class MockImageProvider {
  name = 'mock';

  async submit({ generation }) {
    return { jobId: `mock_job_${generation.id}` };
  }

  async waitForResult({ generation }) {
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
