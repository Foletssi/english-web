// Generate a rollback-only migration test for the official Supabase CLI.
import fs from 'node:fs';
const files=['20260916120000_responsive_catalog_covers.sql','20260916121000_catalog_difficulty_tracks.sql','20260916122000_reviewed_teaching_refresh.sql'];
const bodies=files.map(name=>fs.readFileSync('supabase/migrations/'+name,'utf8').replace(/^begin;\s*$/mi,'').replace(/^commit;\s*$/mi,''));
const checks=fs.readFileSync('audit/catalog_refresh_transaction_test.sql','utf8')+'\n'+fs.readFileSync('audit/teaching_refresh_transaction_test.sql','utf8');
fs.writeFileSync('tmp/catalog643-rollback.sql','begin;\n'+bodies.join('\n')+'\n'+checks+"\nrollback;\nselect 'catalog_refresh_passed_rolled_back' as result;\n");
console.log('Prepared tmp/catalog643-rollback.sql; execute through the official linked CLI.');
