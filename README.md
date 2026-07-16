# OMP Azure DevOps resources

Oh My Pi extension that adds immutable Azure DevOps PR/build resources to the built-in `read` tool and an op-dispatched tool for PR, repository, and Code Search operations. It registers `ado-pr://`, `ado-build://`, and `azure_devops`, so agents use structured interfaces rather than constructing `az` commands.

## URI contract

| URI | Resolves to |
| --- | --- |
| `ado-pr://` | Active pull requests for the Azure DevOps repository at the session cwd. |
| `ado-pr://<id>` | A pull-request detail view for the repository at the session cwd. |
| `ado-pr://<organization>/<project>/<repository>` | Active pull requests for an explicit repository. |
| `ado-pr://<organization>/<project>/<repository>/<id>` | Pull-request detail. |
| `ado-pr://<organization>/<project>/<repository>/<id>/changes` | Changed-file list from the latest pull-request iteration. |

### Builds

| URI | Resolves to |
| --- | --- |
| `ado-build://` | Recent builds for the Azure DevOps project at the session cwd. |
| `ado-build://<id>` | Build detail for the project at the session cwd. |
| `ado-build://<organization>/<project>` | Recent builds for an explicit project. |
| `ado-build://<organization>/<project>/<pipeline>` | Recent builds for an exact pipeline name. |
| `ado-build://<organization>/<project>/<build-id>` | Build detail. |
| `ado-build://<organization>/<project>/<build-id>/timeline` | Stages, jobs, and tasks, with paths to task logs. |
| `ado-build://<organization>/<project>/<build-id>/logs/<log-id>` | Up to 2,000 task-log lines; use `?startLine=<n>&endLine=<n>` to select a page. |

The short forms derive identity from either `https://dev.azure.com/<org>/<project>/_git/<repository>` or `git@ssh.dev.azure.com:v3/<org>/<project>/<repository>` origin remotes. Use the fully-qualified shape outside an Azure DevOps checkout.

## Tool contract

The extension registers one `azure_devops` tool for operations beyond reads. Pick an operation with `op`; every operation uses only its relevant fields. The tool is write-approved because it includes mutations. Use `ado-pr://` and `ado-build://` for all PR and build reads.

| Operation | Required fields | Effect |
| --- | --- | --- |
| `pr_create` | `repository`, `sourceBranch`, `title` | Creates a squash-merge PR; optional `targetBranch`, `description`, `draft`, and reviewer lists. |
| `pr_update` | `pullRequestId` plus `title`, `description`, or `draft` | Updates PR metadata. |
| `pr_vote` | `pullRequestId`, `vote` | Sets the caller's PR vote. |
| `pr_abandon` | `pullRequestId` | Abandons a PR. |
| `pr_set_auto_complete` | `pullRequestId`, `autoComplete` | Enables or disables auto-complete. |
| `pr_complete` | `pullRequestId`, `confirm: true` | Completes a PR as a squash merge. `bypassPolicy` also requires `bypassPolicyReason`. |
| `repo_create` | `name` | Creates a repository. |
| `repo_update` | `repository` plus `name` or `defaultBranch` | Renames a repository or changes its default branch. |
| `repo_delete` | `repository`, `confirm: true` | Deletes a repository. |
| `code_search` | `query` | Searches literal text across every repository in a project; optional `repository`, `path`, `branch`, `limit`, and `skip` filters. |

`organization` and `project` derive from the current Azure DevOps checkout when omitted. Outside such a checkout, provide both explicitly. `repository` also defaults to the checkout where applicable. Code Search returns up to 1,000 matches per call and does not support regular expressions. Work-item operations are deliberately excluded; manage work in Jira.

```text
azure_devops(op="code_search", project="ExampleProject", query="ExampleSymbol", limit=100)
azure_devops(op="pr_create", repository="example-repository", sourceBranch="feature/example", title="feat: improve retries")
azure_devops(op="pr_complete", pullRequestId=12345, confirm=true, deleteSourceBranch=true)
```

## Install

The extension requires Oh My Pi `16.5.0` or later, Azure CLI, and an authenticated `azure-devops` extension.

```sh
omp install github:brutaldeluxe82/omp-azure-devops
```

For development:

```sh
omp install /absolute/path/to/omp-azure-devops
bun test
```

Restart Oh My Pi after installing. Resource reads and the `azure_devops` tool are then available:

```text
read ado-pr://example-org/ExampleProject/example-repository/12345
read ado-pr://example-org/ExampleProject/example-repository/12345/changes
read ado-build://example-org/ExampleProject/67890
read ado-build://example-org/ExampleProject/67890/timeline
read ado-build://example-org/ExampleProject/67890/logs/35
read 'ado-build://example-org/ExampleProject/67890/logs/35?startLine=2001&endLine=4000'
```

## Security and failure behavior

- All `ado-pr://` and `ado-build://` resources are immutable and read-only.
- `azure_devops` is write-approved; `pr_complete` and `repo_delete` additionally require `confirm: true`, and policy bypass requires a non-empty reason.
- Code Search uses the Azure DevOps extension's signed credential session because its search endpoint does not accept Azure CLI Bearer tokens.
- Work-item management is not registered by this extension.
- URI segments reject empty, traversal, slash-containing, and non-numeric build, pull-request, and log IDs.
- Azure CLI failures retain their diagnostic text; missing auth instructs the caller to use `az login` and install the Azure DevOps extension.
- Changed-file enumeration pages through Azure DevOps results and stops after 10,000 files rather than silently truncating.
