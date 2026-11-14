// AstroNot team profiles shown on /about.
//
// Source and archive credits (NASA/IPAC IRSA, ESA/Hubble, and so on) belong in the
// README and on the pages that use those images. They are not team membership and
// must never be added here.
//
// Each profile is one object:
//   {
//     name: "Full name",                           // required
//     role: "Role on AstroNot",                    // required
//     contribution: "One or two sentences.",       // optional
//     photo: {                                     // optional, only with permission
//       src: "assets/team/first-last.jpg",         // path under assets/team/, from the site root
//       alt: "Short description of the photo",     // required when a photo is set
//       crop: { left: 0, top: 0, size: 600, width: 800 } // optional, in original image pixels
//     },
//     link: {                                      // optional, only with permission
//       url: "https://example.org/profile",        // https only
//       label: "Website"                           // visible link text
//     }
//   }
window.ASTRONOT_TEAM = [
  {
    name: "Mehin Mashadiyeva",
    role: "Project Manager",
    photo: {
      src: "assets/team/mehin-mashadiyeva.jpg",
      alt: "Portrait of Mehin Mashadiyeva",
      crop: { left: 336, top: 0, size: 650, width: 1280 },
    },
  },
  {
    name: "Aykhan Isgandarzada",
    role: "System Engineer",
    photo: {
      src: "assets/team/aykhan-isgandarzada.jpg",
      alt: "Portrait of Aykhan Isgandarzada",
      crop: { left: 420, top: 236, size: 520, width: 960 },
    },
  },
  {
    name: "Uzeyir Bayramli",
    role: "ML/Data Analyst",
    photo: {
      src: "assets/team/uzeyir-bayramli.jpg",
      alt: "Portrait of Uzeyir Bayramli",
      crop: { left: 268, top: 603, size: 690, width: 1200 },
    },
  },
  {
    name: "Khadija Ahmadova",
    role: "Backend Developer",
    photo: {
      src: "assets/team/khadija-ahmadova.jpg",
      alt: "Portrait of Khadija Ahmadova",
      crop: { left: 281, top: 508, size: 385, width: 1086 },
    },
  },
  {
    name: "Jahid Mahmudzada",
    role: "Frontend Developer",
    photo: {
      src: "assets/team/jahid-mahmudzada.png",
      alt: "Portrait of Jahid Mahmudzada",
      crop: { left: 245, top: 100, size: 465, width: 800 },
    },
  },
];
