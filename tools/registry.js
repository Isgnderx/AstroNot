const toolCategories = {
  observation: "Observation",
  analysis: "Analysis",
  processing: "Data Processing",
};

const scientificTools = [
  {
    id: "sky-survey-viewer",
    route: "sky-explorer",
    name: "Sky Explorer",
    category: "observation",
    description: "Navigate SPHEREx images by RA and Dec. Pan, zoom, and adjust the field of view.",
    image: "assets/tools/spherex-dust.jpg",
    imageAlt: "SPHEREx infrared image of a dust cloud in the Large Magellanic Cloud",
    caption: "SPHEREx · 3.29 μm",
    available: true,
    preview: {
      title: "Survey image preview",
      steps: ["Choose a SPHEREx observation", "Set RA, Dec, and field of view", "Pan and zoom the image"],
      source: "https://science.nasa.gov/photojournal/spherexs-dust-cloud-reveal/",
      credit: "NASA/JPL-Caltech",
    },
  },
  {
    id: "multi-epoch-viewer",
    route: "time-machine",
    name: "Time Machine",
    category: "observation",
    description: "Compare observations from different dates with a timeline and blink view.",
    diagram: "epochs",
    available: true,
    preview: {
      title: "Epoch comparison",
      alt: "Schematic of the same sky field in two epochs, with a region marked for comparison",
      steps: ["Choose observations of the same field", "Set the reference and target epochs", "Compare the frames side by side or blink between them"],
    },
  },
  {
    id: "spectral-viewer",
    route: "spectrum",
    name: "Spectrum Lab",
    category: "observation",
    description: "Plot flux density against wavelength from a spectrum CSV, with error bars, units, flags and a sortable table.",
    diagram: "bands",
    available: true,
  },
  {
    id: "moving-object-analysis",
    route: "motion",
    name: "Motion Detector",
    category: "analysis",
    description: "Find moving-object candidates across aligned multi-epoch observations and measure their motion.",
    diagram: "motion",
    available: true,
  },
  {
    id: "observation-search",
    route: "observation-search",
    name: "Observation Search",
    category: "observation",
    description: "Find SPHEREx observations by sky position, date, and wavelength coverage.",
    diagram: "cone-search",
    available: true,
  },
  {
    id: "fits-viewer",
    route: "fits-viewer",
    name: "FITS Viewer",
    category: "processing",
    description: "Inspect FITS images, header cards, and Header Data Units in your browser.",
    image: "assets/tools/fits-preview.png",
    imageAlt: "Grayscale preview of a SPHEREx Quick Release 2 image cutout",
    caption: "SPHEREx QR2 · FITS cutout",
    available: true,
  },
  {
    id: "spectrophotometry",
    route: "spectrophotometry",
    name: "Spectrophotometry",
    category: "analysis",
    description: "Inspect flux measurements and uncertainties across infrared wavelengths.",
    diagram: "flux",
    available: true,
  },
  {
    id: "source-detection",
    route: "source-detection",
    name: "Source Detection",
    category: "analysis",
    description: "Identify sources in astronomical images and measure their positions.",
    diagram: "sources",
    available: true,
  },
  {
    id: "light-curve-analysis",
    route: "light-curve-analysis",
    name: "Light Curve Analysis",
    category: "analysis",
    description: "Visualize how a source’s measured brightness changes over time.",
    diagram: "light-curve",
    available: true,
  },
  {
    id: "catalog-cross-match",
    route: "catalog-cross-match",
    name: "Catalog Cross-Match",
    category: "analysis",
    description: "Compare your source positions with a Gaia DR3 or AllWISE extract within an angular radius.",
    diagram: "cross-match",
    available: true,
  },
  {
    id: "image-differencing",
    route: "image-differencing",
    name: "Image Differencing",
    category: "processing",
    description: "Subtract aligned astronomical images to locate changes between exposures.",
    diagram: "difference",
    available: true,
  },
  {
    id: "mosaic-builder",
    route: "mosaic-builder",
    name: "Mosaic Builder",
    category: "processing",
    description: "Combine overlapping observations into a single image of a larger sky field.",
    diagram: "mosaic",
    available: true,
  },
];

function workspaceHref(tool) {
  return tool.route ? sitePage("/tools/" + tool.route) : siteAsset("workspace.html?tool=" + tool.id);
}

function toolImage(tool, diagram = tool.diagram) {
  return siteAsset(tool.image ?? "assets/tools/methods.svg#" + diagram);
}
