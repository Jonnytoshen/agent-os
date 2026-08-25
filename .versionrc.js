export default {
  types: [
    {
      type: 'feat',
      section: '🚀 Features',
    },
    {
      type: 'fix',
      section: '🩹 Bug Fixes',
    },
    {
      type: 'chore',
      scope: 'deps',
      section: '🧱 Dependency Bumps',
    },
    {
      type: 'build',
      scope: 'deps',
      section: '🧱 Dependency Bumps',
    },
  ],
  releaseCommitMessageFormat: 'chore(release): v{{currentTag}}',
  tagPrefix: 'v',
  writerOpts: {
    finalizeContext(context) {
      if (Array.isArray(context.noteGroups)) {
        for (const noteGroup of context.noteGroups) {
          if (noteGroup.title.toUpperCase() === 'BREAKING CHANGES') {
            noteGroup.title = '⚠️  Breaking Changes';
          }
        }
      }
      return context;
    },
  },
};
