# Gateway k3s operations notes

`health-probes.yaml` is the existing strategic-merge patch for the gateway
container's liveness and readiness probes. It is applied by ops to the existing
Deployment; it does not define the complete Deployment.

## Required replica contract

The gateway Deployment must explicitly pin `spec.replicas: 1`. The supported
contract is **exactly one gateway replica; no overlapping rolling deployments**.
Do not allow an old and new gateway pod to run at the same time: deletion
tombstones, RAM-only sessions and middleware state, runner registries, and the
file-backed notify/ledger stores are process-local or single-writer state.

This is a deliberate deployment choice, not a temporary gap. Multi-replica
account-deletion coordination would be a separate distributed-coordination
project. There is no in-process way to detect the real replica count; an
environment flag cannot assert the actual count, so the Deployment and rollout
configuration are the enforcement points.
