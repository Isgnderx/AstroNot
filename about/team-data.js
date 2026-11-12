// AstroNot team profiles shown on /about.
//
// Add a profile only when the person has confirmed their own details and agreed to
// show them publicly. Leave this list empty until then: the page keeps the
// "Team profiles are coming soon" message while the list is empty.
//
// Source and archive credits (NASA/IPAC IRSA, ESA/Hubble, and so on) belong in the
// README and on the pages that use those images. They are not team membership and
// must never be added here.
//
// Each profile is one object:
//   {
//     name: "Full name",                           // required
//     role: "Role on AstroNot",                    // required
//     contribution: "One or two sentences.",       // required
//     photo: {                                     // optional, only with permission
//       src: "assets/team/first-last.jpg",         // path under assets/team/, from the site root
//       alt: "Short description of the photo"      // required when a photo is set
//     },
//     link: {                                      // optional, only with permission
//       url: "https://example.org/profile",        // https only
//       label: "Website"                           // visible link text
//     }
//   }
window.ASTRONOT_TEAM = [];
