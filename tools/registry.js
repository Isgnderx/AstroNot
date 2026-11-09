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
    description: "Examine the same region of sky across different infrared wavelength bands.",
    diagram: "bands",
    preview: {
      title: "Spectral analysis",
      diagram: "flux",
      alt: "Schematic showing a flux measurement and its uncertainty within a wavelength band",
      steps: ["Choose a source and its observations", "Select the wavelength range", "Inspect flux and uncertainty across bands"],
    },
  },
  {
    id: "moving-object-analysis",
    route: "motion",
    name: "Motion Detector",
    category: "analysis",
    description: "Track position changes in asteroids, comets, and nearby stars across epochs.",
    diagram: "motion",
    preview: {
      title: "Difference imaging",
      diagram: "difference",
      alt: "Schematic of subtracting one aligned exposure from another to find changes",
      steps: ["Choose reference and target exposures", "Align the images and inspect their difference", "Review positions across observation dates"],
    },
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
    name: "Spectrophotometry",
    category: "analysis",
    description: "Inspect flux measurements and uncertainties across infrared wavelengths.",
    diagram: "flux",
  },
  {
    id: "source-detection",
    name: "Source Detection",
    category: "analysis",
    description: "Identify sources in astronomical images and measure their positions.",
    diagram: "sources",
  },
  {
    id: "light-curve-analysis",
    name: "Light Curve Analysis",
    category: "analysis",
    description: "Visualize how a source’s measured brightness changes over time.",
    diagram: "light-curve",
  },
  {
    id: "catalog-cross-match",
    name: "Catalog Cross-Match",
    category: "analysis",
    description: "Compare SPHEREx source positions with entries in Gaia and WISE.",
    diagram: "cross-match",
  },
  {
    id: "image-differencing",
    name: "Image Differencing",
    category: "processing",
    description: "Subtract aligned astronomical images to locate changes between exposures.",
    diagram: "difference",
  },
  {
    id: "mosaic-builder",
    name: "Mosaic Builder",
    category: "processing",
    description: "Combine overlapping observations into a single image of a larger sky field.",
    diagram: "mosaic",
  },
];

function workspaceHref(tool) {
  return tool.route ? sitePage("/tools/" + tool.route) : siteAsset("workspace.html?tool=" + tool.id);
}

function toolImage(tool, diagram = tool.diagram) {
  return siteAsset(tool.image ?? "assets/tools/methods.svg#" + diagram);
}
