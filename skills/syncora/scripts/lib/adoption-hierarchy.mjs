import { SyncoraError } from "./cli.mjs";

function hierarchyError(message, details = undefined) {
  return new SyncoraError("MIGRATE010", message, details);
}

function activeCanonical(notes, kind) {
  return notes.filter(
    (note) =>
      note.currentSchema &&
      note.frontmatter.kind === kind &&
      note.frontmatter.state === "active" &&
      note.authorityClass === (kind === "atlas" ? "routing" : "canonical"),
  );
}

function canonicalProjectTargets(graph, sourcePath, projectsByPath) {
  return new Set(
    (graph.outgoing.get(sourcePath) ?? [])
      .map((edge) => edge.targetPath)
      .filter((path) => projectsByPath.has(path)),
  );
}

export function validateAdoptionHubHierarchy(notes, graph) {
  const atlases = activeCanonical(notes, "atlas");
  if (atlases.length !== 1) {
    throw hierarchyError(
      "Staged graph must contain exactly one active canonical atlas.",
      { count: atlases.length },
    );
  }

  const projects = activeCanonical(notes, "project");
  const workspaceHubs = projects.filter(
    (note) => note.frontmatter.scope === "workspace",
  );
  if (workspaceHubs.length !== 1) {
    throw hierarchyError(
      "Staged graph must contain exactly one active canonical workspace hub.",
      { count: workspaceHubs.length },
    );
  }

  const atlas = atlases[0];
  const workspaceHub = workspaceHubs[0];
  const projectsByPath = new Map(projects.map((note) => [note.path, note]));
  const atlasProjectTargets = canonicalProjectTargets(
    graph,
    atlas.path,
    projectsByPath,
  );
  if (!atlasProjectTargets.has(workspaceHub.path)) {
    throw hierarchyError(
      "The active atlas must link directly to the canonical workspace hub.",
      { atlas: atlas.path, workspaceHub: workspaceHub.path },
    );
  }

  const competingAtlasTargets = [...atlasProjectTargets]
    .filter((path) => path !== workspaceHub.path)
    .sort();
  if (competingAtlasTargets.length > 0) {
    throw hierarchyError(
      "The active atlas must route project knowledge through the workspace hub, not directly to workstream hubs.",
      {
        atlas: atlas.path,
        workspaceHub: workspaceHub.path,
        competingTargets: competingAtlasTargets.slice(0, 50),
      },
    );
  }

  const workstreamHubs = projects
    .filter((note) => note.path !== workspaceHub.path)
    .sort((left, right) => left.path.localeCompare(right.path));
  const workspaceProjectTargets = canonicalProjectTargets(
    graph,
    workspaceHub.path,
    projectsByPath,
  );
  const orphanedWorkstreams = workstreamHubs
    .filter((note) => !workspaceProjectTargets.has(note.path))
    .map((note) => ({
      path: note.path,
      scope: note.frontmatter.scope,
    }));
  if (orphanedWorkstreams.length > 0) {
    throw hierarchyError(
      "Every active canonical workstream hub must be linked directly from the workspace hub.",
      {
        workspaceHub: workspaceHub.path,
        orphanedWorkstreams: orphanedWorkstreams.slice(0, 50),
      },
    );
  }

  return {
    atlas: atlas.path,
    workspaceHub: workspaceHub.path,
    workstreamHubs: workstreamHubs.map((note) => ({
      path: note.path,
      scope: note.frontmatter.scope,
    })),
  };
}
