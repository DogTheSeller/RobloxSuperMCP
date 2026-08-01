import { contentHash } from './studio_utils.js';
import * as getRelatedCode from './get_related_code.js';
import * as impactAnalysis from './impact_analysis.js';

export async function run(args = {}) {
    const request = String(args.request || args.task || args.change || '').trim();
    if (!request) return JSON.stringify({ error: 'Provide the requested feature or change.' });

    const related = JSON.parse(await getRelatedCode.run({
        task: request,
        limit: Math.min(50, Number(args.limit || 25))
    }));
    const riskTarget = String(args.target || related.RelevantFiles?.[0]?.Path || request);
    const impact = JSON.parse(await impactAnalysis.run({
        change: riskTarget,
        max_depth: args.max_depth
    }));
    const files = related.RelevantFiles || [];
    const remoteNames = [...new Set(files.flatMap(file =>
        (file.RemoteUsage || []).map(usage => usage.Name)
    ))];
    const persistence = files.filter(file =>
        (file.ServicesUsed || []).includes('DataStoreService')
    );

    const phases = [
        {
            Phase: 1,
            Name: 'Establish preconditions',
            Actions: [
                'Refresh analyze_project if the cache is stale.',
                'Read exact live source hashes for every mutation target.',
                ...(remoteNames.length ? ['Validate the affected remote contracts before editing.'] : []),
                ...(persistence.length ? ['Audit profile/session and receipt integrity before editing.'] : [])
            ],
            Mutation: false
        },
        {
            Phase: 2,
            Name: 'Implement atomically',
            Actions: [
                'Apply exact-path patches with expected source hashes and match counts.',
                'Keep server authority and lifecycle ownership in the responsible modules.',
                'Record a reversible transaction for every Studio mutation.'
            ],
            Mutation: true
        },
        {
            Phase: 3,
            Name: 'Verify',
            Actions: [
                'Verify post-write source hashes and intended instance state.',
                'Rerun lifecycle, remote, race, performance, and data-integrity audits as applicable.',
                'Refresh the project index and compare the affected dependency graph.'
            ],
            Mutation: false
        }
    ];
    const planCore = {
        Request: request,
        PrimaryTarget: impact.Target || null,
        RiskAssessment: impact.RiskAssessment || { Level: 'UNKNOWN', Reasons: ['No indexed target was resolved.'] },
        AffectedFiles: files.map(file => ({
            Path: file.Path,
            Name: file.Name,
            ClassName: file.ClassName,
            RelevanceScore: file.RelevanceScore,
            MatchEvidence: file.MatchEvidence || file.MatchedTerms
        })),
        NetworkContracts: remoteNames,
        PersistenceComponents: persistence.map(file => file.Path),
        DownstreamImpact: impact.AffectedSystems || null,
        Phases: phases
    };

    return JSON.stringify({
        PlanId: contentHash(JSON.stringify(planCore)).slice(0, 16),
        GeneratedAt: new Date().toISOString(),
        ...planCore,
        Preconditions: {
            ExactPathsRequired: true,
            LiveSourceHashesRequiredForMutation: true,
            DryRunRecommended: true,
            RollbackTransactionRequired: true
        },
        Evidence: 'indexed-project-analysis',
        NonMutating: true
    }, null, 2);
}
