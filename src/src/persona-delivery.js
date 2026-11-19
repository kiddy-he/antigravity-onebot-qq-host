/** Only an explicit failed persona review permits another model rewrite.
 * Reuse the review only for the exact draft it judged. A changed final reply
 * must be checked again; unavailable reviewers preserve the existing draft.
 */
export async function needsPersonaRewrite(text, { skip = false, reviewed, review, signal, onDecision } = {}) {
    signal?.throwIfAborted();
    if (skip || !String(text ?? '').trim()) return false;
    const reused = reviewed?.text === text;
    let decision;
    try {
        decision = reused ? reviewed.decision : await review(text);
    } catch (error) {
        signal?.throwIfAborted();
        onDecision?.({ judgement: 'unavailable', reused, error: true });
        return false;
    }
    signal?.throwIfAborted();
    const rewrite = decision?.judgement === 'reject';
    onDecision?.({ judgement: decision?.judgement ?? 'unavailable', reused, rewrite });
    return rewrite;
}
