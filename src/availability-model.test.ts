import test from 'node:test';
import assert from 'node:assert/strict';
import {availabilityRanges,toggleAvailabilityHour} from './availability-model';
import {seed,execute} from './domain';
test('consecutive blocks merge into ranges, including midnight and end of day',()=>{assert.deepEqual(availabilityRanges([23,0,1,1,22,9]),[{from:0,to:2},{from:9,to:10},{from:22,to:24}]);assert.deepEqual(availabilityRanges([]),[])});
test('selecting a fourth range is rejected without mutating selected hours',()=>{const hours=[8,9,12,16];assert.throws(()=>toggleAvailabilityHour(hours,20),/maksymalnie 3/);assert.deepEqual(hours,[8,9,12,16]);assert.deepEqual(toggleAvailabilityHour(hours,10),[8,9,10,12,16])});
test('deselecting a middle hour cannot split three ranges into four',()=>{const hours=[8,9,10,13,17];assert.throws(()=>toggleAvailabilityHour(hours,9),/maksymalnie 3/);assert.deepEqual(toggleAvailabilityHour(hours,8),[9,10,13,17])});
test('joining ranges and clearing a day remain possible',()=>{assert.deepEqual(toggleAvailabilityHour([8,10,14],9),[8,9,10,14]);assert.deepEqual(toggleAvailabilityHour([23],23),[])});
test('server domain rejects a fourth range even if client bypasses the grid',()=>{const db=seed();db.sessions=[];db.holds=[];const actor={role:'admin' as const,trainerId:'',clientId:''};assert.throws(()=>execute(db,actor,{type:'availability',trainerId:db.trainers[0].id,days:[0],hours:[6,9,12,15],weeklyHours:{0:[6,9,12,15]}}),/maksymalnie 3/);const next=execute(db,actor,{type:'availability',trainerId:db.trainers[0].id,days:[0],hours:[6,7,10,14],weeklyHours:{0:[6,7,10,14]}});assert.deepEqual(next.trainers[0].weeklyHours,{0:[6,7,10,14]})});
