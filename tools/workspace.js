function renderWorkspacePreview(content, tool) {
  const preview = tool.preview;
  content.innerHTML = `
    <div class="workspace-preview">
      <aside class="workspace-panel workspace-preview__sidebar" aria-labelledby="workflow-title">
        <p class="workspace-availability">Coming Soon</p>
        <h2 id="workflow-title">Planned workflow</h2>
        <ol></ol>
        <div class="workspace-preview__links">
          <h3>Available tools</h3>
          <a class="workspace-source" data-preview-search>Observation Search</a>
          <a class="workspace-source" data-preview-fits>FITS Viewer</a>
        </div>
      </aside>
      <figure class="workspace-panel workspace-preview__figure">
        <div class="workspace-preview__bar">
          <h2></h2>
          <span>Read-only preview</span>
        </div>
        <img class="workspace-preview__image" alt="">
        <figcaption class="workspace-help"></figcaption>
      </figure>
    </div>`;

  const list = content.querySelector("ol");
  for (const step of preview.steps) {
    const item = document.createElement("li");
    item.textContent = step;
    list.append(item);
  }
  content.querySelector("[data-preview-search]").href = sitePage("/tools/observation-search");
  content.querySelector("[data-preview-fits]").href = sitePage("/tools/fits-viewer");
  content.querySelector(".workspace-preview__bar h2").textContent = preview.title;
  const image = content.querySelector("img");
  image.src = toolImage(tool, preview.diagram);
  image.alt = tool.imageAlt ?? preview.alt ?? "";
  image.classList.toggle("workspace-preview__image--photo", Boolean(tool.image));

  const caption = content.querySelector("figcaption");
  if (preview.source) {
    const source = document.createElement("a");
    source.href = preview.source;
    source.textContent = preview.credit;
    caption.append(tool.caption + " · ", source);
  } else {
    caption.textContent = "Method diagram · Planned workflow";
  }
}

function openWorkspace() {
  const directId = document.body.dataset.workspaceId;
  const id = directId ?? new URLSearchParams(location.search).get("tool");
  const tool = scientificTools.find((entry) => entry.id === id);
  const heading = document.querySelector("[data-workspace-title]");
  const description = document.querySelector("[data-workspace-description]");
  const content = document.querySelector("[data-workspace-content]");

  if (!tool) {
    heading.textContent = id ? "Workspace not found" : "Choose a workspace";
    description.textContent = "Return to Scientific Tools to select a workspace.";
    return;
  }

  if (!directId && tool.route) {
    location.replace(workspaceHref(tool));
    return;
  }

  document.title = tool.name + " — AstroNot";
  document.querySelector("[data-workspace-crumb]").textContent = tool.name;
  document.querySelector("[data-workspace-category]").textContent = toolCategories[tool.category];
  heading.textContent = tool.name;
  description.textContent = tool.description;

  if (tool.preview) {
    renderWorkspacePreview(content, tool);
  } else {
    content.innerHTML = '<section class="workspace-panel pending-workspace"><h2>Coming Soon</h2><p>This workspace is in development.</p></section>';
  }
}

openWorkspace();
