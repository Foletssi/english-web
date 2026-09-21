begin;
do $test$
declare row_value jsonb := $json${
  "id":"sentence-1","english":"Read","chinese":"阅读","textRevision":1,"expressions":[],
  "wordLookup":{"schemaVersion":1,"sourceTextRevision":1,"sourceEnglish":"Read","tokens":[
    {"tokenId":"t0","surface":"Read","start":0,"end":4,"coreMeaningZh":"阅读","pronunciationHint":"/riːd/"}]},
  "translationAnalysis":{"status":"completed","promptVersion":"context-lookup-v3-20260919",
    "reviewVersion":"context-delta-review-v3-20260919","sourceTextRevision":1,"sourceConcerns":[]},
  "coverageAnalysis":{"schemaVersion":1,"status":"completed","promptVersion":"adjacent-coverage-v2-20260916",
    "reviewVersion":"adult-selection-review-v2-20260916","sourceTextRevision":1,"pairs":[]},
  "teachingAnalysis":{"reviewVersion":"adult-selection-review-v2-20260916"}
}$json$::jsonb;
begin
  if private.learning_details_valid_v1(row_value) is distinct from true then
    raise exception 'DELTA_REVIEW_CONTRACT_REJECTED';
  end if;
end;
$test$;
rollback;
