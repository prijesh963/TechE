package com.creditoptimizer.core.handoff

enum class ChangeKind { ADD, UPDATE, DELETE }

/**
 * One file a [FeaturePlan] touches. [reason] is free text Copilot gave for
 * touching it — never independently verified the way the old
 * Copilot Architect project's grounding did, since that needs a full
 * symbol-graph "is this claim true" checker this project doesn't have.
 * What *is* checked, in [CopilotHandoffService.importPlan], is narrower
 * but real: an `UPDATE`/`DELETE` naming a path the index has never seen
 * for that service is dropped rather than trusted.
 */
data class PlannedFile(
    val service: String,
    val path: String,
    val kind: ChangeKind,
    val reason: String
)

/**
 * A versioned plan for one feature request, built from a Copilot Chat
 * reply pasted back in. Mirrors the `intellij-main` branch's plan-contract
 * shape (request -> revisions -> explicit approval -> implement) at a
 * scale that fits this project: no separate session/decision model, no
 * grounding/claim verification beyond the file-path check above - a
 * plan here is a lighter-weight, single-purpose record, not a full
 * feature-planning subsystem.
 */
data class FeaturePlan(
    val id: String,
    val request: String,
    val revision: Int,
    val summary: String,
    val files: List<PlannedFile>,
    val steps: List<String>,
    val approved: Boolean = false,
    val createdAtEpochMillis: Long = System.currentTimeMillis()
)
