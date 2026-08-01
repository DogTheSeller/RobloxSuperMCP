const RULES = [
    { id: 'deprecated-wait', severity: 'Error', pattern: /(?<![\w.])wait\s*\(/g, message: "Use task.wait() instead of wait()." },
    { id: 'deprecated-spawn', severity: 'Error', pattern: /(?<![\w.])spawn\s*\(/g, message: "Use a tracked task.spawn() thread instead of spawn()." },
    { id: 'deprecated-delay', severity: 'Error', pattern: /(?<![\w.])delay\s*\(/g, message: "Use a tracked task.delay() thread instead of delay()." },
    { id: 'zero-frame-wait', severity: 'Error', pattern: /\btask\.wait\s*\(\s*(?:0\s*)?\)/g, message: 'Do not yield an arbitrary frame to hide a race condition.' },
    { id: 'legacy-pairs', severity: 'Warning', pattern: /\b(?:i?pairs)\s*\(/g, message: 'Use generalized Luau iteration in new code.' },
    { id: 'unbounded-wait-for-child', severity: 'Error', pattern: /WaitForChild\s*\(\s*[^,\n)]+\)/g, message: 'WaitForChild() must include an explicit timeout.' },
    { id: 'parented-construction', severity: 'Warning', pattern: /Instance\.new\s*\(\s*[^,\n]+,\s*[^)\n]+\)/g, message: 'Set properties first and assign Parent last.' },
    { id: 'load-character', severity: 'Error', pattern: /:\s*LoadCharacter\s*\(/g, message: 'Avoid mid-game LoadCharacter(); reset the character in place.' },
    { id: 'global-random', severity: 'Warning', pattern: /\bmath\.random\s*\(/g, message: 'Use a server-owned Random object for authoritative logic.' },
    { id: 'mouse-button-click', severity: 'Warning', pattern: /\.MouseButton1Click\b/g, message: 'Use GuiButton.Activated.' },
    { id: 'legacy-body-mover', severity: 'Error', pattern: /\bBody(?:Velocity|Position|Gyro)\b/g, message: 'Use modern mover constraints.' },
    { id: 'set-async', severity: 'Critical', pattern: /:\s*SetAsync\s*\(/g, message: 'SetAsync is forbidden for transactional player data; use a session-locked profile system or guarded UpdateAsync.' },
    { id: 'old-ray-api', severity: 'Error', pattern: /\b(?:Ray\.new|FindPartOnRay)\b/g, message: 'Use workspace:Raycast().' },
    { id: 'humanoid-load-animation', severity: 'Warning', pattern: /:\s*LoadAnimation\s*\(/g, message: 'Load animations through Animator:LoadAnimation().' },
    { id: 'direct-players-access', severity: 'Warning', pattern: /\bgame\.Players\b/g, message: 'Cache Players through game:GetService().' },
    { id: 'direct-workspace-access', severity: 'Warning', pattern: /\bgame\.Workspace\b/g, message: 'Use the workspace global.' },
    { id: 'legacy-global-state', severity: 'Critical', pattern: /\b_G\b/g, message: 'Global shared state is forbidden; use responsibility-scoped modules.' },
    { id: 'unbounded-polling', severity: 'Warning', pattern: /\bwhile\s+true\s+do\b/g, message: 'Use an event-driven mechanism or an explicit termination condition.' }
];

export async function run(args) {
    const source = String(args.content || args.script_content || '');
    const scriptName = String(args.script_name || 'Script');
    if (!source) {
        return JSON.stringify({ ScriptAudited: scriptName, Status: 'No script content provided.' }, null, 2);
    }

    const sanitized = stripCommentsAndStrings(source);
    const findings = [];
    const firstCodeLine = source.split(/\r?\n/).find(line => line.trim() !== '')?.trim();
    if (firstCodeLine !== '--!strict') {
        findings.push(finding('strict-typing', 'Warning', 1, 'Functional scripts should begin with --!strict.'));
    }

    for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        for (const match of sanitized.matchAll(rule.pattern)) {
            findings.push(finding(rule.id, rule.severity, lineAt(sanitized, match.index), rule.message));
        }
    }

    const remoteHandlerPattern = /\b(?:OnServerEvent|OnServerInvoke)\b/g;
    for (const match of sanitized.matchAll(remoteHandlerPattern)) {
        const handlerEnd = sanitized.indexOf('end)', match.index);
        const handlerSource = sanitized.slice(match.index, handlerEnd >= 0 ? handlerEnd + 4 : match.index + 2000);
        if (!/\btypeof\s*\(/.test(handlerSource)) {
            findings.push(finding('remote-runtime-validation', 'Critical', lineAt(sanitized, match.index), 'Server remote handler has no visible local typeof() runtime validation.'));
        }
    }
    for (const match of sanitized.matchAll(/[:.]?(?:FireServer|InvokeServer)\s*\(([^)\n]*)\)/g)) {
        if (/(?:^|,)\s*(?:-?\d+(?:\.\d+)?|math\.huge)\b/.test(match[1])) {
            findings.push(finding(
                'client-authoritative-number',
                'Critical',
                lineAt(sanitized, match.index),
                'A client remote call visibly sends a number; verify it is not dictating amount, cost, damage, or reward.'
            ));
        }
    }
    if (/[.:]Connect\s*\(/.test(sanitized) && !/\b(?:Janitor|Maid|Trove)\b/.test(stripComments(source))) {
        findings.push(finding('connection-lifecycle', 'Warning', firstLineMatching(sanitized, /[.:]Connect\s*\(/), 'Connections are present without visible Janitor, Maid, or Trove ownership.'));
    }
    if (/\btask\.(?:spawn|delay|defer)\s*\(/.test(sanitized) && !/\btask\.cancel\s*\(/.test(sanitized)) {
        findings.push(finding('thread-lifecycle', 'Warning', firstLineMatching(sanitized, /\btask\.(?:spawn|delay|defer)\s*\(/), 'Spawned or delayed work has no visible cancellation path.'));
    }

    findings.sort((a, b) => a.Line - b.Line || severityWeight(b.Severity) - severityWeight(a.Severity));
    const penalty = findings.reduce((total, item) => total + severityWeight(item.Severity), 0);

    return JSON.stringify({
        ScriptAudited: scriptName,
        Score: Math.max(0, 100 - penalty),
        Status: findings.length === 0 ? 'PASS' : 'REVIEW REQUIRED',
        Summary: countBySeverity(findings),
        Findings: findings,
        Evidence: 'line-aware-static-source',
        Caveat: 'Static pattern analysis highlights review targets; it does not prove runtime safety.'
    }, null, 2);
}

function finding(rule, severity, line, message) {
    return { Rule: rule, Severity: severity, Line: line, Message: message };
}

function stripCommentsAndStrings(source) {
    return stripComments(source)
        .replace(/\[(=*)\[[\s\S]*?\]\1\]/g, match => match.replace(/[^\n]/g, ' '))
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, match => match.replace(/[^\n]/g, ' '));
}

function stripComments(source) {
    return source
        .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, match => match.replace(/[^\n]/g, ' '))
        .replace(/--[^\n]*/g, match => ' '.repeat(match.length))
        ;
}

function lineAt(source, index = 0) {
    return source.slice(0, index).split('\n').length;
}

function firstLineMatching(source, pattern) {
    const match = pattern.exec(source);
    return lineAt(source, match?.index || 0);
}

function severityWeight(severity) {
    return { Warning: 5, Error: 10, Critical: 20 }[severity] || 0;
}

function countBySeverity(findings) {
    return Object.fromEntries(['Critical', 'Error', 'Warning'].map(severity => [
        severity,
        findings.filter(item => item.Severity === severity).length
    ]));
}
