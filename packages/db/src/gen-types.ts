// Placeholder for DB type generation. We hand-maintain row shapes in @tt/shared
// and the query modules (via quoted column aliases), so generation is optional.
// If you want Supabase-generated types, run:
//
//   npx supabase gen types typescript \
//     --project-id <your-project-ref> \
//     --schema public,time_tracker > packages/db/src/database.types.ts
//
console.log(
  'No-op. To generate Supabase types, run:\n' +
    '  npx supabase gen types typescript --project-id <your-project-ref> ' +
    '--schema public,time_tracker > packages/db/src/database.types.ts',
);
