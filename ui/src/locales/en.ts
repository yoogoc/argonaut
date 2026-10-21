// English needs no catalogue (the keys are English), except for singular forms of counted strings:
// i18next looks up "<key>_one" when count is 1 and falls back to the key itself otherwise.
const en: Record<string, string> = {
  "All {{count}} replicas have loaded it_one": "The only replica has loaded it",
  "Delete {{count}} workflows?_one": "Delete 1 workflow?",
  "Done for {{count}} workflows_one": "Done for 1 workflow",
  "Terminate {{count}} workflows?_one": "Terminate 1 workflow?",
  "{{behind}} of {{count}} replicas are catching up_one": "The only replica is catching up",
  "{{count}} lines_one": "1 line",
  "{{count}} problems_one": "1 problem",
  "{{n}} problems_one": "1 problem",
  retried_one: "retried once",
  retried_other: "retried {{count}} times",
};

export default en;
