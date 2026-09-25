// src/availability-model.ts
function availabilityRanges(hours) {
  const ranges = [];
  for (const hour2 of [...new Set(hours)].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last.to === hour2) last.to = hour2 + 1;
    else ranges.push({ from: hour2, to: hour2 + 1 });
  }
  return ranges;
}

// src/domain.ts
var defaultRules = { renewalDays: 7, cycleWeeks: 4, validWeeks: 6, coachHoldHours: 48, checkoutMinutes: 15, protectionDays: 1, consultationDays: 7, startDays: 14, substituteHours: 48, freezeDays: 7 };
var rules = (db) => Object.fromEntries(Object.entries(defaultRules).map(([key, value]) => [key, db.settings.rules?.[key] ?? value]));
var packagePrice = (db, service2, intensity) => db.settings.packagePrices?.[service2]?.[intensity] ?? db.settings[service2] * intensity * rules(db).cycleWeeks;
var trainerHours = (t, day2) => t.weeklyHours ? t.weeklyHours[day2] || [] : t.days.includes(day2) ? t.hours : [];
var defaultLocation = { id: "00000000-0000-4000-8000-000000000ac0", name: "Studio ACO!", address: "" };
var locationsOf = (db) => db.locations?.length ? db.locations : [defaultLocation];
var uid = () => crypto.randomUUID();
var dateOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
var dayAdd = (s, n) => {
  const d = /* @__PURE__ */ new Date(s + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
var at = (d, h) => {
  const target = Date.parse(`${d}T${String(h).padStart(2, "0")}:00:00Z`);
  if (!Number.isFinite(target)) return /* @__PURE__ */ new Date(NaN);
  const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const wall2 = Date.parse(formatter.format(new Date(instant)).replace(" ", "T") + "Z");
    instant += target - wall2;
  }
  const resolved = new Date(instant);
  return formatter.format(resolved).slice(0, 13) === `${d} ${String(h).padStart(2, "0")}` ? resolved : /* @__PURE__ */ new Date(NaN);
};
var endAt = (s) => new Date(+at(s.date, s.hour) + (s.kind === "consultation" ? 90 : 60) * 6e4);
var weekOf = (s) => dayAdd(s, -dayIndex(s));
var dayIndex = (s) => ((/* @__PURE__ */ new Date(s + "T12:00:00Z")).getUTCDay() + 6) % 7;
var labelDate = (s, opts = { day: "numeric", month: "long" }) => (/* @__PURE__ */ new Date(s.slice(0, 10) + "T12:00:00")).toLocaleDateString("pl-PL", opts);
var hourLabel = (h) => `${String(h).padStart(2, "0")}:00`;
var serviceName = (s) => s === "physio" ? "Powr\xF3t do zdrowia" : "Trening personalny";
var statusLabels = { scheduled: "Zaplanowany", completed: "Zrealizowany", no_show: "Nieobecno\u015B\u0107", cancelled_early: "Odwo\u0142any na czas", cancelled_late: "P\xF3\u017Ane odwo\u0142anie", cancelled_trainer: "Odwo\u0142any przez trenera" };
var spends = (s) => ["completed", "no_show", "cancelled_late"].includes(s.status);
var counts = (s) => s.status === "scheduled" || spends(s);
var unbooked = (db, p) => Math.max(0, p.count - db.sessions.filter((s) => s.packageId === p.id && counts(s)).length);
var currentPackage = (db, id2) => db.packages.filter((p) => p.clientId === id2).sort((a, b) => b.start.localeCompare(a.start))[0];
var canSee = (db, a, c) => a.role === "admin" || a.role === "client" && a.clientId === c.id && c.active || a.role === "trainer" && (a.trainerId === c.trainerId || db.substitutions.some((s) => s.clientId === c.id && s.trainerId === a.trainerId && s.until > db.now));
function available(db, trainerId, date2, hour2, clientId, exclude, ignoreHold) {
  const t = db.trainers.find((t2) => t2.id === trainerId);
  const now = new Date(db.now);
  if (!Number.isFinite(+at(date2, hour2)) || !t || t.deleted || !trainerHours(t, dayIndex(date2)).includes(hour2) || +at(date2, hour2) <= +now) return false;
  if (db.blocks.some((b) => b.trainerId === trainerId && b.date === date2 && b.hour === hour2)) return false;
  if (db.sessions.some((s) => s.id !== exclude && s.date === date2 && (s.status === "scheduled" || s.kind === "consultation" && s.status === "completed" && endAt(s) > now) && (s.trainerId === trainerId || s.clientId === clientId) && hour2 >= s.hour && hour2 < s.hour + (s.kind === "consultation" ? 2 : 1))) return false;
  if (db.holds.some((h) => h.id !== ignoreHold && h.status === "active" && h.expires > db.now && (h.trainerId === trainerId || h.clientId === clientId) && h.dates.some((d) => d.date === date2 && d.hour === hour2))) return false;
  if (db.packages.some((p) => p.clientId !== clientId && db.clients.find((c) => c.id === p.clientId)?.trainerId === trainerId && p.protectionUntil > dateOf(new Date(db.now)) && date2 >= p.start && p.slots.some((s) => s.day === dayIndex(date2) && s.hour === hour2) && !db.sessions.some((s) => s.packageId === p.id && (s.date === date2 && s.hour === hour2 && s.status.startsWith("cancelled") || s.original === `${date2} ${hourLabel(hour2)}`)))) return false;
  return true;
}
function notify(db, title, body, clientId) {
  db.messages.unshift({ id: uid(), title, body: clientId ? `${db.clients.find((c) => c.id === clientId)?.name || "Klient"} \xB7 ${body}` : body, clientId, at: db.now, read: false, target: "all" });
}
function audit(db, text2) {
  db.audit.unshift({ id: uid(), text: text2, at: db.now });
}
function effectiveRate(db, s) {
  const t = db.trainers.find((t2) => t2.id === s.trainerId);
  const service2 = db.packages.find((p) => p.id === s.packageId)?.service || db.clients.find((c) => c.id === s.clientId)?.service || "personal";
  const rates = t.productRateHistory?.filter((r) => r.from <= s.date).sort((a, b) => b.from.localeCompare(a.from))[0] || t.productRates;
  if (rates) return rates[service2];
  return t.rates?.filter((r) => r.from <= s.date).sort((a, b) => b.from.localeCompare(a.from))[0]?.rate ?? t.rate;
}
function requireStaff(a) {
  if (!["admin", "trainer"].includes(a.role)) throw Error("Ta operacja wymaga uprawnie\u0144 trenera.");
}
function requireAdmin(a) {
  if (a.role !== "admin") throw Error("Ta operacja jest dost\u0119pna tylko administratorowi.");
}
function getSession(db, a, id2) {
  const s = db.sessions.find((s2) => s2.id === id2);
  if (!s) throw Error("Nie znaleziono sesji.");
  const c = db.clients.find((c2) => c2.id === s.clientId);
  if (!canSee(db, a, c)) throw Error("Brak dost\u0119pu do tego klienta.");
  return s;
}
function limitCheck(db, c, date2, exclude, extra = [], ignoreHold) {
  if (db.sessions.some((s) => s.id !== exclude && s.clientId === c.id && s.kind === "training" && s.date === date2 && counts(s)) || extra.some((d) => d.date === date2) || db.holds.some((h) => h.id !== ignoreHold && h.clientId === c.id && h.status === "active" && h.expires > db.now && h.dates.some((d) => d.date === date2))) throw Error("Mo\u017Cna um\xF3wi\u0107 tylko jeden trening dziennie.");
  const n = db.sessions.filter((s) => s.id !== exclude && s.clientId === c.id && s.kind === "training" && weekOf(s.date) === weekOf(date2) && counts(s)).length + db.holds.filter((h) => h.id !== ignoreHold && h.clientId === c.id && h.status === "active" && h.expires > db.now).flatMap((h) => h.dates).filter((d) => weekOf(d.date) === weekOf(date2)).length + extra.filter((d) => weekOf(d.date) === weekOf(date2)).length;
  if (n >= c.intensity) throw Error(`Limit ${c.intensity} trening\xF3w w tygodniu zosta\u0142 wykorzystany. Wybierz inny tydzie\u0144.`);
}
function execute(source, a, cmd) {
  const db = structuredClone(source);
  const now = new Date(db.now);
  if (["productCopy", "promotion", "disablePromotion", "extraHours"].includes(cmd.type)) return business(db, a, cmd);
  db.holds.forEach((h) => {
    if (h.status === "active" && h.expires <= db.now) h.status = "expired";
  });
  switch (cmd.type) {
    case "availability": {
      requireAdmin(a);
      const t = db.trainers.find((t2) => t2.id === cmd.trainerId && !t2.deleted);
      if (!t) throw Error("Nie znaleziono trenera.");
      if (cmd.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || cmd.hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) throw Error("Wybierz dni i godziny pracy.");
      const weekly = cmd.weeklyHours || Object.fromEntries(cmd.days.map((d) => [d, cmd.hours]));
      if (Object.entries(weekly).some(([d, hs]) => !Number.isInteger(Number(d)) || Number(d) < 0 || Number(d) > 6 || !Array.isArray(hs) || hs.some((h) => !Number.isInteger(h) || h < 0 || h > 23))) throw Error("Niepoprawny zakres godzin.");
      if (Object.values(weekly).some((hs) => availabilityRanges(hs).length > 3)) throw Error("W jednym dniu mo\u017Cna ustawi\u0107 maksymalnie 3 zakresy godzin.");
      const fits = (date2, hour2) => (weekly[dayIndex(date2)] || []).includes(hour2);
      if (db.sessions.some((s) => s.trainerId === t.id && s.status === "scheduled" && at(s.date, s.hour) > now && (!fits(s.date, s.hour) || s.kind === "consultation" && !fits(s.date, s.hour + 1))) || db.holds.some((h) => h.trainerId === t.id && h.status === "active" && h.expires > db.now && h.dates.some((d) => !fits(d.date, d.hour)))) throw Error("Zmiana koliduje z zaplanowan\u0105 wizyt\u0105 lub rezerwacj\u0105. Najpierw zmie\u0144 jej termin.");
      t.weeklyHours = structuredClone(weekly);
      t.days = [...new Set(Object.keys(weekly).map(Number).filter((d) => weekly[d].length))].sort((a2, b) => a2 - b);
      t.hours = [...new Set(Object.values(weekly).flat())].sort((a2, b) => a2 - b);
      audit(db, "Administrator zaktualizowa\u0142 dost\u0119pno\u015B\u0107: " + t.name);
      break;
    }
    case "outcome": {
      const s = getSession(db, a, cmd.id);
      if (s.status !== "scheduled") throw Error("Ta sesja zosta\u0142a ju\u017C rozliczona.");
      if (["completed", "no_show"].includes(cmd.status)) {
        requireStaff(a);
        if (a.role === "trainer" && s.trainerId !== a.trainerId) throw Error("Sesj\u0119 rozlicza trener, kt\xF3ry j\u0105 prowadzi\u0142.");
        if ((s.kind === "consultation" ? +at(s.date, s.hour) + 30 * 6e4 : +endAt(s)) > +now) throw Error(s.kind === "consultation" ? "Konsultacj\u0119 mo\u017Cna rozliczy\u0107 30 minut po rozpocz\u0119ciu." : "Sesj\u0119 mo\u017Cna rozliczy\u0107 dopiero po jej zako\u0144czeniu.");
        s.status = cmd.status;
        s.rate = effectiveRate(db, s);
        s.earned = s.rate * (s.kind === "consultation" ? 1.5 : 1);
      } else {
        if (s.kind === "consultation" && a.role !== "admin") throw Error("W sprawie zmiany konsultacji skontaktuj si\u0119 z administratorem ACO!.");
        if (+at(s.date, s.hour) <= +now) throw Error("Ta sesja ju\u017C si\u0119 rozpocz\u0119\u0142a. Oznacz realizacj\u0119 lub nieobecno\u015B\u0107.");
        const coach = a.role === "trainer" || a.role === "admin" && cmd.status === "cancelled_trainer";
        s.status = coach ? "cancelled_trainer" : +at(s.date, s.hour) - +now >= db.settings.cancelHours * 36e5 ? "cancelled_early" : "cancelled_late";
        if (s.status === "cancelled_late") {
          s.rate = effectiveRate(db, s);
          s.earned = s.rate * (s.kind === "consultation" ? 1.5 : 1);
        }
      }
      notify(db, statusLabels[s.status], `${labelDate(s.date)}, ${hourLabel(s.hour)}. ${s.status === "cancelled_trainer" ? "Wej\u015Bcie jest dost\u0119pne do ponownego um\xF3wienia." : ""}`, s.clientId);
      audit(db, `${statusLabels[s.status]}: ${s.id}`);
      break;
    }
    case "notes": {
      requireStaff(a);
      const s = getSession(db, a, cmd.id);
      s.publicNote = cmd.publicNote;
      s.privateNote = cmd.privateNote;
      if (a.role === "trainer") db.messages.unshift({ id: uid(), title: "Trener doda\u0142 notatk\u0119", body: `${db.trainers.find((t) => t.id === a.trainerId)?.name}: ${db.clients.find((c) => c.id === s.clientId)?.name}, ${labelDate(s.date)}.`, at: db.now, read: false, target: "admin" });
      audit(db, `Zapisano notatki sesji ${s.id}`);
      break;
    }
    case "comment": {
      const s = getSession(db, a, cmd.id);
      if (!cmd.text.trim()) throw Error("Wpisz tre\u015B\u0107 komentarza.");
      s.comments.push({ id: uid(), author: a.role === "client" ? db.clients.find((c) => c.id === a.clientId).name : a.role === "admin" ? "Administrator" : db.trainers.find((t) => t.id === a.trainerId).name, text: cmd.text.trim(), at: db.now });
      notify(db, "Nowy komentarz", `Nowa wiadomo\u015B\u0107 przy sesji ${labelDate(s.date)}.`, s.clientId);
      break;
    }
    case "reschedule": {
      const s = getSession(db, a, cmd.id);
      if (s.kind === "consultation") {
        requireAdmin(a);
        if (s.status !== "scheduled" || at(s.date, s.hour) <= now) throw Error("Mo\u017Cna zmieni\u0107 tylko przysz\u0142\u0105 konsultacj\u0119.");
        if (!available(db, s.trainerId, cmd.date, cmd.hour, s.clientId, s.id) || !available(db, s.trainerId, cmd.date, cmd.hour + 1, s.clientId, s.id)) throw Error("Konsultacja wymaga dw\xF3ch wolnych godzin.");
        s.original = s.original || `${s.date} ${hourLabel(s.hour)}`;
        s.date = cmd.date;
        s.hour = cmd.hour;
        notify(db, "Zmieniono konsultacj\u0119", `${labelDate(s.date)}, ${hourLabel(s.hour)}`, s.clientId);
        break;
      }
      if (s.status !== "scheduled") throw Error("Mo\u017Cna prze\u0142o\u017Cy\u0107 tylko zaplanowany trening.");
      if (+at(s.date, s.hour) - +now < db.settings.cancelHours * 36e5) throw Error(`Zosta\u0142o mniej ni\u017C ${db.settings.cancelHours} h. Odwo\u0142aj sesj\u0119 (wej\u015Bcie przepadnie), a now\u0105 um\xF3w z wolnego wej\u015Bcia.`);
      const p = db.packages.find((p2) => p2.id === s.packageId);
      if (cmd.date < p.start || cmd.date >= p.validUntil || p.frozen) throw Error("Termin jest poza wa\u017Cno\u015Bci\u0105 pakietu albo pakiet jest zamro\u017Cony.");
      if (!available(db, s.trainerId, cmd.date, cmd.hour, s.clientId, s.id)) throw Error("Ten termin jest niedost\u0119pny.");
      limitCheck(db, db.clients.find((c) => c.id === s.clientId), cmd.date, s.id);
      s.original = s.original || `${s.date} ${hourLabel(s.hour)}`;
      s.date = cmd.date;
      s.hour = cmd.hour;
      notify(db, "Zmieniono termin treningu", `Nowy termin: ${labelDate(s.date)}, ${hourLabel(s.hour)}.`, s.clientId);
      audit(db, `Prze\u0142o\u017Cono sesj\u0119 ${s.id}`);
      break;
    }
    case "prescribe": {
      requireStaff(a);
      const c = db.clients.find((c2) => c2.id === cmd.id);
      if (c.invited || c.active) throw Error("Po aktywacji nie mo\u017Cna zmienia\u0107 produktu.");
      if (!canSee(db, a, c) || a.role === "trainer" && c.trainerId !== a.trainerId) throw Error("Produkt przypisuje trener prowadz\u0105cy.");
      if (!db.trainers.find((t) => t.id === c.trainerId)?.products?.includes(cmd.service) && db.trainers.find((t) => t.id === c.trainerId)?.products) throw Error("Trener nie prowadzi wybranego produktu.");
      if (![1, 2, 3].includes(cmd.intensity)) throw Error("Wybierz intensywno\u015B\u0107 1, 2 lub 3.");
      if (db.packages.some((p) => p.clientId === c.id && p.validUntil > dateOf(new Date(db.now))) && cmd.intensity !== c.intensity) throw Error("Zmie\u0144 intensywno\u015B\u0107 po zako\u0144czeniu bie\u017C\u0105cych pakiet\xF3w.");
      c.service = cmd.service;
      c.intensity = cmd.intensity;
      c.prescribed = true;
      audit(db, `Przypisano wariant: ${c.name}, ${c.intensity}\xD7 / tydzie\u0144`);
      break;
    }
    case "activate": {
      requireStaff(a);
      const c = db.clients.find((c2) => c2.id === cmd.id);
      if (!c) throw Error("Nie znaleziono klienta.");
      if (a.role === "trainer" && c.trainerId !== a.trainerId) throw Error("Aktywuje trener prowadz\u0105cy.");
      if (c.invited || c.active) throw Error("Klient jest ju\u017C zatwierdzony.");
      const consultation = db.sessions.find((s) => s.clientId === c.id && s.kind === "consultation" && ["scheduled", "completed"].includes(s.status) && +at(s.date, s.hour) + 30 * 6e4 <= +now);
      if (a.role !== "admin" && !consultation) throw Error("Aktywacja jest dost\u0119pna 30 minut po rozpocz\u0119ciu konsultacji.");
      const service2 = cmd.service || (c.prescribed ? c.service : void 0), intensity = cmd.intensity || (c.prescribed ? c.intensity : void 0);
      if (!service2 || !intensity || ![1, 2, 3].includes(intensity) || !["personal", "physio"].includes(service2)) throw Error("Wybierz produkt i intensywno\u015B\u0107.");
      const t = db.trainers.find((t2) => t2.id === c.trainerId);
      if (t.products && !t.products.includes(service2)) throw Error("Trener nie prowadzi tego produktu.");
      c.service = service2;
      c.intensity = intensity;
      c.prescribed = true;
      c.invited = true;
      if (consultation && consultation.status === "scheduled") {
        consultation.status = "completed";
        consultation.rate = effectiveRate(db, consultation);
        consultation.earned = consultation.rate * 1.5;
      }
      notify(db, "Mo\u017Cesz aktywowa\u0107 konto", "Mo\u017Cesz ustawi\u0107 has\u0142o podaj\u0105c e-mail i dat\u0119 urodzenia.", c.id);
      db.messages[0].target = "client";
      audit(db, `Zatwierdzono aktywacj\u0119 i produkt: ${c.name}`);
      break;
    }
    case "acceptInvite": {
      const c = db.clients.find((c2) => c2.id === cmd.id);
      if (a.role !== "client" || a.clientId !== c.id || !c.invited) throw Error("Brak zaproszenia do aktywacji.");
      c.active = true;
      notify(db, "Witamy w ACO!", "Twoje konto jest aktywne. Mo\u017Cesz wybra\u0107 terminy trening\xF3w.", c.id);
      db.messages[0].target = "client";
      break;
    }
    case "register":
    case "manualClient": {
      if (cmd.type === "manualClient") requireAdmin(a);
      if (!cmd.name.trim() || !/^\S+@\S+\.\S+$/.test(cmd.email.trim())) throw Error("Podaj imi\u0119, nazwisko i poprawny e-mail.");
      if (db.clients.some((c) => c.email.toLowerCase() === cmd.email.trim().toLowerCase())) throw Error("Profil z tym adresem e-mail ju\u017C istnieje.");
      const id2 = uid();
      if (cmd.type === "register") {
        if (cmd.date > dayAdd(dateOf(new Date(db.now)), rules(db).consultationDays)) throw Error(`Konsultacj\u0119 mo\u017Cna um\xF3wi\u0107 maksymalnie ${rules(db).consultationDays} dni naprz\xF3d.`);
        if (!available(db, cmd.trainerId, cmd.date, cmd.hour) || !available(db, cmd.trainerId, cmd.date, cmd.hour + 1)) throw Error("Konsultacja wymaga dw\xF3ch wolnych godzin.");
        db.sessions.push({ id: uid(), clientId: id2, trainerId: cmd.trainerId, date: cmd.date, hour: cmd.hour, kind: "consultation", status: "scheduled", publicNote: "", privateNote: "", comments: [] });
        db.sales.unshift({ id: uid(), clientId: id2, label: "Konsultacja", amount: db.settings.consultation, date: db.now, status: "paid" });
      }
      db.clients.push({ id: id2, name: cmd.name.trim(), email: cmd.email.trim().toLowerCase(), phone: cmd.phone, trainerId: cmd.trainerId, active: false, invited: false, service: db.trainers.find((t) => t.id === cmd.trainerId)?.products?.[0] || "personal", intensity: 2, prescribed: false, birthDate: cmd.type === "register" ? cmd.birthDate : void 0, answers: cmd.type === "register" ? cmd.answers : [] });
      notify(db, cmd.type === "register" ? "Konsultacja zarezerwowana" : "Dodano profil klienta", `${cmd.type === "register" ? labelDate(cmd.date) + ", " + hourLabel(cmd.hour) + " \xB7 " + db.trainers.find((t) => t.id === cmd.trainerId)?.name + ". " : ""}Aktywacja nast\u0105pi po konsultacji i zatwierdzeniu przez trenera. Aby zmieni\u0107 konsultacj\u0119, skontaktuj si\u0119 z administratorem.`, id2);
      audit(db, `Dodano profil: ${cmd.name}`);
      break;
    }
    case "hold": {
      const c = db.clients.find((c2) => c2.id === cmd.clientId);
      if (!renewalAllowed(db, c.id)) throw Error(`Kolejny pakiet mo\u017Cna kupi\u0107 ${rules(db).renewalDays} dni przed ko\u0144cem obecnego cyklu.`);
      if (new Set(cmd.slots.map((s) => s.day)).size !== cmd.slots.length) throw Error("Wybierz najwy\u017Cej jeden trening w ka\u017Cdym dniu.");
      if (!canSee(db, a, c) || !c.prescribed) throw Error("Najpierw przypisz produkt klientowi.");
      if (cmd.slots.length !== c.intensity || cmd.dates.length !== c.intensity * rules(db).cycleWeeks) throw Error("Wybierz wszystkie sta\u0142e godziny i terminy pakietu.");
      if (db.packages.some((p) => p.clientId === c.id && cmd.start < p.cycleEnd && dayAdd(cmd.start, rules(db).cycleWeeks * 7) > p.start)) throw Error("Nowy cykl nie mo\u017Ce nak\u0142ada\u0107 si\u0119 na obecny.");
      if (db.holds.some((h) => h.clientId === c.id && h.status === "active" && h.expires > db.now)) throw Error("Ten klient ma ju\u017C rezerwacj\u0119 wst\u0119pn\u0105.");
      for (const slot of cmd.slots) {
        const occurrences = Array.from({ length: rules(db).cycleWeeks }, (_, w) => dayAdd(cmd.start, (slot.day - dayIndex(cmd.start) + 7) % 7 + w * 7));
        if (occurrences.filter((d) => !available(db, c.trainerId, d, slot.hour, c.id)).length > rules(db).cycleWeeks / 2) throw Error("Ponad po\u0142owa termin\xF3w tej sta\u0142ej godziny jest zaj\u0119ta. Wybierz inn\u0105 godzin\u0119.");
      }
      const selected = [];
      for (const d of cmd.dates) {
        if (d.date < cmd.start || d.date >= dayAdd(cmd.start, rules(db).cycleWeeks * 7)) throw Error(`Wszystkie daty musz\u0105 zmie\u015Bci\u0107 si\u0119 w ${rules(db).cycleWeeks} tygodniach.`);
        if (!available(db, c.trainerId, d.date, d.hour, c.id)) throw Error(`Termin ${labelDate(d.date)} ${hourLabel(d.hour)} jest niedost\u0119pny.`);
        if (cmd.dates.filter((x) => x.date === d.date && x.hour === d.hour).length > 1) throw Error("Dwa treningi nie mog\u0105 mie\u0107 tego samego terminu.");
        limitCheck(db, c, d.date, void 0, selected);
        selected.push(d);
      }
      if ([...cmd.dates].sort((a2, b) => a2.date.localeCompare(b.date))[c.intensity - 1].date > dayAdd(dateOf(new Date(db.now)), rules(db).startDays)) throw Error(`Pierwsze ${c.intensity} treningi musz\u0105 odby\u0107 si\u0119 w ci\u0105gu ${rules(db).startDays} dni od zakupu.`);
      const first = Math.min(...cmd.dates.map((d) => +at(d.date, d.hour)));
      const expires = new Date(Math.min(+now + (a.role === "client" ? rules(db).checkoutMinutes / 60 : rules(db).coachHoldHours) * 36e5, first)).toISOString();
      db.holds.unshift({ id: uid(), clientId: c.id, trainerId: c.trainerId, dates: cmd.dates, slots: cmd.slots, start: [...cmd.dates].sort((a2, b) => a2.date.localeCompare(b.date))[0].date, expires, service: c.service, intensity: c.intensity, price: packagePrice(db, c.service, c.intensity), terms: rules(db), status: "active", type: a.role === "client" ? "checkout" : "coach" });
      notify(db, "Terminy czekaj\u0105 na op\u0142acenie", `Zarezerwowano ${cmd.dates.length} trening\xF3w z ${db.trainers.find((t) => t.id === c.trainerId)?.name}. Pierwszy: ${labelDate(cmd.dates.slice().sort((a2, b) => a2.date.localeCompare(b.date))[0].date)}. P\u0142atno\u015B\u0107 do ${new Date(expires).toLocaleString("pl-PL")}.`, c.id);
      break;
    }
    case "editHold": {
      const h = db.holds.find((h2) => h2.id === cmd.id);
      const c = db.clients.find((c2) => c2.id === h.clientId);
      if (!canSee(db, a, c) || h.status !== "active" || h.expires <= db.now) throw Error("Rezerwacja nie jest aktywna.");
      if (cmd.dates.length !== h.dates.length) throw Error("Zachowaj wszystkie treningi.");
      const selected = [];
      for (const d of cmd.dates) {
        if (d.date < h.start || d.date >= dayAdd(h.start, (h.terms || defaultRules).cycleWeeks * 7)) throw Error("Wybierz termin w cyklu zarezerwowanego pakietu.");
        if (!available(db, h.trainerId, d.date, d.hour, c.id, void 0, h.id)) throw Error("Wybrany termin jest niedost\u0119pny.");
        if (cmd.dates.filter((x) => x.date === d.date && x.hour === d.hour).length > 1) throw Error("Daty nie mog\u0105 si\u0119 powtarza\u0107.");
        limitCheck(db, c, d.date, void 0, selected, h.id);
        selected.push(d);
      }
      h.dates = cmd.dates;
      audit(db, "Zmieniono wyj\u0105tki rezerwacji bez przed\u0142u\u017Cenia terminu p\u0142atno\u015Bci");
      break;
    }
    case "payHold": {
      const h = db.holds.find((h2) => h2.id === cmd.id);
      const c = db.clients.find((c2) => c2.id === h.clientId);
      if (!canSee(db, a, c)) throw Error("Brak dost\u0119pu.");
      if (h.status === "paid") throw Error("Ten pakiet zosta\u0142 ju\u017C op\u0142acony.");
      if (h.terms && h.terms.cycleWeeks !== rules(db).cycleWeeks) throw Error("Zmieniono d\u0142ugo\u015B\u0107 pakietu. Wybierz terminy ponownie.");
      if (h.expires <= db.now) throw Error("Rezerwacja wygas\u0142a. Wybierz terminy ponownie.");
      for (const d of h.dates) if (!available(db, h.trainerId, d.date, d.hour, h.clientId, void 0, h.id)) throw Error("Termin przesta\u0142 by\u0107 dost\u0119pny. Skontaktuj si\u0119 z administratorem.");
      if ([...h.dates].sort((a2, b) => a2.date.localeCompare(b.date))[h.intensity - 1].date > dayAdd(dateOf(new Date(db.now)), rules(db).startDays)) throw Error("Pierwsze treningi wypadaj\u0105 poza dozwolonym terminem rozpocz\u0119cia.");
      if (!renewalAllowed(db, c.id)) throw Error("Zakup kolejnego pakietu nie jest jeszcze dost\u0119pny.");
      const pricing = quote(db, c.id, h.service, h.intensity, cmd.code);
      h.price = pricing.total;
      const terms = h.terms || defaultRules;
      const id2 = uid();
      db.packages.push({ id: id2, clientId: h.clientId, count: h.dates.length, start: h.start, cycleEnd: dayAdd(h.start, (h.terms || defaultRules).cycleWeeks * 7), validUntil: dayAdd(h.start, terms.validWeeks * 7), protectionUntil: dayAdd(h.start, terms.cycleWeeks * 7 + terms.protectionDays), slots: h.slots, service: h.service, intensity: h.intensity, price: h.price, basePrice: pricing.base, discountPercent: pricing.percent, promotionId: pricing.promotionId });
      if (pricing.code) {
        const promo = db.promotions.find((p) => p.id === pricing.promotionId);
        promo.used++;
      }
      for (const d of h.dates) db.sessions.push({ id: uid(), clientId: h.clientId, trainerId: h.trainerId, packageId: id2, date: d.date, hour: d.hour, kind: "training", status: "scheduled", publicNote: "", privateNote: "", comments: [], original: d.original });
      h.status = "paid";
      db.sales.unshift({ id: uid(), packageId: id2, clientId: c.id, label: `${serviceName(h.service)} \xB7 ${trainingCount(h.dates.length)}`, amount: h.price, date: db.now, status: "paid" });
      notify(db, "Tw\xF3j pakiet jest aktywny", `${trainingCount(h.dates.length)}. Pakiet aktywny.`, c.id);
      audit(db, `Potwierdzenie p\u0142atno\u015Bci za pakiet: ${c.name}`);
      break;
    }
    case "makeup": {
      const p = db.packages.find((p2) => p2.id === cmd.packageId);
      const c = db.clients.find((c2) => c2.id === p.clientId);
      if (!canSee(db, a, c) || p.frozen || !unbooked(db, p) || cmd.date >= p.validUntil || cmd.date < p.start) throw Error("Brak wa\u017Cnego wej\u015Bcia na ten termin.");
      if (!available(db, c.trainerId, cmd.date, cmd.hour, c.id)) throw Error("Termin jest zaj\u0119ty.");
      limitCheck(db, c, cmd.date);
      db.sessions.push({ id: uid(), clientId: c.id, trainerId: c.trainerId, packageId: p.id, date: cmd.date, hour: cmd.hour, kind: "training", status: "scheduled", publicNote: "", privateNote: "", comments: [] });
      notify(db, "Um\xF3wiono trening", `${labelDate(cmd.date)}, ${hourLabel(cmd.hour)}.`, c.id);
      break;
    }
    case "substitute": {
      requireAdmin(a);
      const c = db.clients.find((c2) => c2.id === cmd.clientId);
      if (cmd.trainerId === c.trainerId) throw Error("Wybierz innego trenera.");
      const list = db.sessions.filter((s) => s.clientId === c.id && s.status === "scheduled" && s.date >= cmd.from && s.date <= cmd.to);
      if (!list.length) throw Error("Brak przysz\u0142ych wizyt w tym okresie.");
      for (const s of list) {
        if (!available(db, cmd.trainerId, s.date, s.hour, c.id, s.id)) throw Error(`Zast\u0119pca nie jest dost\u0119pny ${labelDate(s.date)} o ${hourLabel(s.hour)}.`);
        if (s.kind === "consultation" && !available(db, cmd.trainerId, s.date, s.hour + 1, c.id, s.id)) throw Error("Brak dw\xF3ch godzin dla konsultacji.");
      }
      const id2 = uid();
      const until = new Date(Math.max(...list.map((s) => +endAt(s))) + rules(db).substituteHours * 36e5).toISOString();
      list.forEach((s) => {
        s.trainerId = cmd.trainerId;
        s.substituteId = id2;
      });
      db.substitutions.push({ id: id2, clientId: c.id, trainerId: cmd.trainerId, until });
      notify(db, "Wyznaczono zast\u0119pstwo", `${db.trainers.find((t) => t.id === cmd.trainerId).name} poprowadzi ${list.length} sesji.`, c.id);
      audit(db, `Przydzielono zast\u0119pstwo: ${c.name}`);
      break;
    }
    case "validity": {
      requireAdmin(a);
      const p = db.packages.find((p2) => p2.id === cmd.packageId);
      if (!p) throw Error("Nie znaleziono pakietu.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cmd.date) || !Number.isFinite(+at(cmd.date, 12)) || dayAdd(cmd.date, 0) !== cmd.date || cmd.date < p.start) throw Error("Wybierz poprawn\u0105 dat\u0119 nie wcze\u015Bniejsz\u0105 ni\u017C pocz\u0105tek pakietu.");
      const until = dayAdd(cmd.date, 1);
      if (db.sessions.some((s) => s.packageId === p.id && s.status === "scheduled" && s.date >= until)) throw Error("Po tej dacie s\u0105 zaplanowane treningi. Najpierw prze\u0142\xF3\u017C je lub odwo\u0142aj.");
      p.validUntil = until;
      notify(db, "Zmieniono wa\u017Cno\u015B\u0107 pakietu", `Nowa wa\u017Cno\u015B\u0107: ${labelDate(cmd.date)}.`, p.clientId);
      audit(db, `Zmieniono wa\u017Cno\u015B\u0107 pakietu klienta ${db.clients.find((c) => c.id === p.clientId)?.name} na ${cmd.date}`);
      break;
    }
    case "extend": {
      requireAdmin(a);
      const p = db.packages.find((p2) => p2.id === cmd.packageId);
      p.validUntil = dayAdd(p.validUntil, cmd.days);
      audit(db, `Przed\u0142u\u017Cono pakiet ${p.id} o ${cmd.days} dni`);
      break;
    }
    case "freeze": {
      requireAdmin(a);
      const p = db.packages.find((p2) => p2.id === cmd.packageId);
      p.frozen = !p.frozen;
      if (p.frozen) {
        db.sessions.filter((s) => s.packageId === p.id && s.status === "scheduled" && at(s.date, s.hour) > now).forEach((s) => s.status = "cancelled_early");
        p.validUntil = dayAdd(p.validUntil, rules(db).freezeDays);
      }
      audit(db, `${p.frozen ? "Zamro\u017Cono pakiet i zwolniono wizyty" : "Odmro\u017Cono pakiet"} ${p.id}`);
      break;
    }
    case "block": {
      requireAdmin(a);
      if (a.role === "trainer" && a.trainerId !== cmd.trainerId) throw Error("Mo\u017Cesz zmieni\u0107 tylko sw\xF3j grafik.");
      if (!available(db, cmd.trainerId, cmd.date, cmd.hour)) throw Error("Najpierw prze\u0142\xF3\u017C istniej\u0105ce wizyty lub wybierz woln\u0105 godzin\u0119.");
      db.blocks.push({ id: uid(), trainerId: cmd.trainerId, date: cmd.date, hour: cmd.hour, visibility: cmd.visibility || "busy" });
      audit(db, "Dodano niedost\u0119pno\u015B\u0107");
      break;
    }
    case "unblock": {
      requireAdmin(a);
      const b = db.blocks.find((b2) => b2.id === cmd.id);
      if (!b || a.role === "trainer" && a.trainerId !== b.trainerId) throw Error("Brak dost\u0119pu.");
      db.blocks = db.blocks.filter((b2) => b2.id !== cmd.id);
      break;
    }
    case "saveLocation": {
      requireAdmin(a);
      if (!cmd.name.trim() || cmd.name.length > 200 || cmd.address.length > 500) throw Error("Podaj nazw\u0119 miejsca (do 200 znak\xF3w) i adres (do 500 znak\xF3w).");
      const locations = locationsOf(db).map((l) => ({ ...l }));
      const location = locations.find((l) => l.id === cmd.id);
      if (location) {
        location.name = cmd.name.trim();
        location.address = cmd.address.trim();
      } else locations.push({ id: cmd.id, name: cmd.name.trim(), address: cmd.address.trim() });
      db.locations = locations;
      audit(db, "Zapisano miejsce: " + cmd.name.trim());
      break;
    }
    case "sessionLocation": {
      requireAdmin(a);
      const s = getSession(db, a, cmd.id);
      if (!locationsOf(db).some((l) => l.id === cmd.locationId)) throw Error("Wybierz istniej\u0105ce miejsce.");
      s.locationId = cmd.locationId;
      audit(db, "Zmieniono miejsce spotkania");
      break;
    }
    case "settings": {
      requireAdmin(a);
      if ([cmd.personal, cmd.physio, cmd.consultation, cmd.cancelHours].some((n) => !Number.isFinite(n) || n <= 0)) throw Error("Warto\u015Bci musz\u0105 by\u0107 wi\u0119ksze od zera.");
      const r = cmd.rules || rules(db);
      if (Object.values(r).some((n) => !Number.isInteger(n) || n < 1) || r.validWeeks < r.cycleWeeks) throw Error("Parametry musz\u0105 by\u0107 dodatnimi liczbami ca\u0142kowitymi; wa\u017Cno\u015B\u0107 nie mo\u017Ce by\u0107 kr\xF3tsza ni\u017C cykl.");
      const prices2 = cmd.packagePrices || db.settings.packagePrices;
      if (prices2 && ["personal", "physio"].some((s) => [1, 2, 3].some((i) => !Number.isFinite(prices2[s]?.[i]) || prices2[s][i] <= 0))) throw Error("Uzupe\u0142nij wszystkie ceny pakiet\xF3w.");
      db.settings = { ...db.settings, personal: cmd.personal, physio: cmd.physio, consultation: cmd.consultation, cancelHours: cmd.cancelHours, rules: r, packagePrices: prices2 };
      audit(db, "Zmieniono cennik i zasady dla nowych operacji");
      break;
    }
    case "rate": {
      requireAdmin(a);
      if (!Number.isFinite(cmd.rate) || cmd.rate <= 0) throw Error("Podaj poprawn\u0105 stawk\u0119.");
      const t = db.trainers.find((t2) => t2.id === cmd.trainerId);
      t.rates ??= [{ from: "2000-01-01", rate: t.rate }];
      t.rates = t.rates.filter((r) => r.from !== dateOf(new Date(db.now)));
      t.rates.push({ from: dateOf(new Date(db.now)), rate: cmd.rate });
      t.rate = cmd.rate;
      audit(db, "Zmieniono stawk\u0119 trenera; naliczone sesje bez zmian");
      break;
    }
    case "read": {
      const m = db.messages.find((m2) => m2.id === cmd.id);
      if (m) m.read = true;
      break;
    }
    case "clock": {
      db.now = new Date(+now + cmd.hours * 36e5).toISOString();
      db.holds.forEach((h) => {
        if (h.status === "active" && h.expires <= db.now) {
          h.status = "expired";
          notify(db, "Rezerwacja wst\u0119pna wygas\u0142a", "Nieop\u0142acone terminy wr\xF3ci\u0142y do puli.", h.clientId);
        }
      });
      break;
    }
  }
  return db;
}
var trainingCount = (n) => `${n} ${n === 1 ? "trening" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "treningi" : "trening\xF3w"}`;

// src/business.ts
var productCopy = (db, s) => db.productCopies?.[s] || { name: s === "physio" ? "Powr\xF3t do zdrowia" : "Trening personalny", subtitle: "Pakiet trening\xF3w indywidualnych. Sta\u0142e godziny i wsparcie trenera.", bullets: ["60 minut tylko dla Ciebie", "Sta\u0142e godziny w grafiku", "Dziennik i komentarze trenera"] };
function quote(db, clientId, service2, intensity, code = "") {
  const c = db.clients.find((c2) => c2.id === clientId);
  const base = packagePrice(db, service2, intensity);
  const promos = (db.promotions || []).filter((p) => p.active);
  const email = promos.filter((p) => p.kind === "email" && p.value === c?.email.toLowerCase()).sort((a, b) => b.percent - a.percent)[0];
  let coupon;
  if (code.trim()) {
    coupon = promos.find((p) => p.kind === "code" && p.value === code.trim().toUpperCase());
    if (!coupon || coupon.used >= coupon.maxUses || coupon.expires < dateOf(new Date(db.now))) throw Error("Kod jest nieprawid\u0142owy, wygas\u0142 lub zosta\u0142 wykorzystany.");
  }
  const chosen = coupon && coupon.percent > (email?.percent || 0) ? coupon : email;
  const percent = chosen?.percent || 0;
  return { base, percent, total: Math.round(base * (100 - percent)) / 100, promotionId: chosen?.id, code: chosen?.kind === "code" ? chosen.value : void 0 };
}
function renewalAllowed(db, id2) {
  const p = currentPackage(db, id2);
  return !p || dateOf(new Date(db.now)) >= dayAdd(p.cycleEnd, -rules(db).renewalDays);
}
function business(db, a, cmd) {
  if (a.role !== "admin") throw Error("Ta operacja jest dost\u0119pna tylko administratorowi.");
  switch (cmd.type) {
    case "productCopy":
      if (!["personal", "physio"].includes(cmd.service) || !cmd.copy.name.trim() || !cmd.copy.subtitle.trim()) throw Error("Uzupe\u0142nij nazw\u0119 i podtytu\u0142.");
      (db.productCopies ??= {})[cmd.service] = { name: cmd.copy.name.trim(), subtitle: cmd.copy.subtitle.trim(), bullets: cmd.copy.bullets.map((s) => s.trim()).filter(Boolean) };
      break;
    case "promotion": {
      const p = cmd.promotion, value = p.kind === "email" ? p.value.trim().toLowerCase() : p.value.trim().toUpperCase();
      if (!value || p.kind === "email" && !/^\S+@\S+\.\S+$/.test(value) || !Number.isFinite(p.percent) || p.percent <= 0 || p.percent > 100) throw Error("Podaj poprawny e-mail lub kod oraz rabat od 1 do 100%.");
      if (p.kind === "code" && (!Number.isInteger(p.maxUses) || p.maxUses < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(p.expires) || p.expires < dateOf(new Date(db.now)))) throw Error("Podaj liczb\u0119 u\u017Cy\u0107 i przysz\u0142\u0105 dat\u0119 wa\u017Cno\u015Bci.");
      if ((db.promotions || []).some((x) => x.active && x.kind === p.kind && x.value === value)) throw Error("Aktywna promocja o tej warto\u015Bci ju\u017C istnieje.");
      (db.promotions ??= []).push({ ...p, id: uid(), value, used: 0 });
      break;
    }
    case "disablePromotion": {
      const p = db.promotions?.find((p2) => p2.id === cmd.id);
      if (p) p.active = false;
      break;
    }
    case "extraHours":
      if (!db.trainers.some((t) => t.id === cmd.trainerId && !t.deleted) || !/^\d{4}-\d{2}$/.test(cmd.month) || !Number.isFinite(cmd.hours) || cmd.hours <= 0 || !Number.isFinite(cmd.rate) || cmd.rate <= 0 || !cmd.description.trim()) throw Error("Wybierz trenera, miesi\u0105c, liczb\u0119 godzin, stawk\u0119 i opis.");
      (db.extraHours ??= []).push({ ...cmd, id: uid(), amount: Math.round(cmd.hours * cmd.rate * 100) / 100 });
      break;
  }
  db.audit.unshift({ id: uid(), at: db.now, text: cmd.type === "extraHours" ? "Dodano pozatreningowy czas pracy" : cmd.type === "productCopy" ? "Zmieniono opis karty produktu" : "Zmieniono promocje" });
  return db;
}

// src/auth.ts
var guest = { role: "guest", trainerId: "", clientId: "" };
function actorFor(a) {
  return { role: a.role, trainerId: a.trainerId || "", clientId: a.clientId || "" };
}
var hex = (b) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, "0")).join("");
async function passwordHash(value, salt = uid()) {
  if (value.length < 10) throw Error("Has\u0142o musi mie\u0107 co najmniej 10 znak\xF3w.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(value), "PBKDF2", false, ["deriveBits"]);
  return { salt, hash: hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 21e4 }, key, 256)) };
}
function unique(db, email) {
  if (!/^\S+@\S+\.\S+$/.test(email)) throw Error("Podaj poprawny e-mail.");
  if (db.accounts.some((a) => a.email === email) || db.clients.some((c) => c.email === email)) throw Error("Konto z tym adresem e-mail ju\u017C istnieje.");
}
function validBirthDate(value, now) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "1900-01-01" && value <= now.slice(0, 10) && (/* @__PURE__ */ new Date(value + "T12:00:00Z")).toISOString().slice(0, 10) === value;
}
async function registerAccount(db, cmd) {
  unique(db, cmd.email.trim().toLowerCase());
  if (!validBirthDate(cmd.birthDate || "", db.now)) throw Error("Podaj poprawn\u0105 dat\u0119 urodzenia.");
  const next = execute(db, guest, cmd);
  const client = next.clients.at(-1);
  next.accounts.push({ id: uid(), email: client.email, role: "client", clientId: client.id });
  return { db: next };
}
async function addTrainer(db, actor, input) {
  if (actor.role !== "admin") throw Error("Tylko administrator mo\u017Ce zarz\u0105dza\u0107 trenerami.");
  const email = input.email.trim().toLowerCase();
  const old = input.id ? db.trainers.find((t) => t.id === input.id && !t.deleted) : void 0;
  if (old && input.password) throw Error("U\u017Cyj opcji wyzerowania has\u0142a.");
  if (input.id && !old) throw Error("Nie znaleziono trenera.");
  const existing = db.accounts.find((a) => a.trainerId === old?.id && a.role === "trainer");
  if (existing?.email !== email) unique(db, email);
  if (!input.name.trim() || !input.products.length || input.products.some((p) => !["personal", "physio"].includes(p) || !Number.isFinite(input.productRates[p]) || input.productRates[p] <= 0) || input.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || input.hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) throw Error("Uzupe\u0142nij dane, produkty, stawki i dost\u0119pno\u015B\u0107.");
  if (input.pesel && !/^\d{11}$/.test(input.pesel)) throw Error("PESEL musi zawiera\u0107 11 cyfr.");
  if (old && db.clients.some((c) => c.trainerId === old.id && c.prescribed && !input.products.includes(c.service))) throw Error("Nie mo\u017Cna wy\u0142\u0105czy\u0107 produktu przypisanego podopiecznym.");
  if (!old && !input.password) throw Error("Ustaw has\u0142o trenera.");
  const password = input.password ? await passwordHash(input.password) : void 0;
  const next = structuredClone(db), id2 = old?.id || uid();
  const { password: ignored, email: ignoredEmail, days: ignoredDays, hours: ignoredHours, ...fields2 } = input;
  const history = old?.productRateHistory || old?.rates?.map((r) => ({ from: r.from, personal: r.rate, physio: r.rate })) || [{ from: "1900-01-01", ...old?.productRates || { personal: old?.rate || 0, physio: old?.rate || 0 } }];
  const trainer = { ...old, ...fields2, id: id2, days: old?.days || [], hours: old?.hours || [], rate: input.productRates[input.products[0]], productRateHistory: [...history.filter((r) => r.from !== dateOf(new Date(db.now))), { from: dateOf(new Date(db.now)), ...input.productRates }] };
  delete trainer.specialty;
  if (old) next.trainers[next.trainers.findIndex((t) => t.id === id2)] = trainer;
  else next.trainers.push(trainer);
  if (existing) {
    const a = next.accounts.find((a2) => a2.id === existing.id);
    a.email = email;
    if (password) a.password = password;
  } else next.accounts.push({ id: uid(), email, role: "trainer", trainerId: id2, password, mustChangePassword: true });
  next.audit.unshift({ id: uid(), at: db.now, text: `${old ? "Zmieniono" : "Dodano"} trenera: ${input.name}` });
  return next;
}

// src/management.ts
var accountOf = (db, a) => db.accounts.find((x) => !x.disabled && x.role === a.role && (a.role === "admin" || a.role === "trainer" && x.trainerId === a.trainerId || a.role === "client" && x.clientId === a.clientId));
var accountName = (db, a) => a.role === "admin" ? a.name || "Administrator ACO!" : a.role === "trainer" ? db.trainers.find((t) => t.id === a.trainerId)?.name || "By\u0142y trener" : db.clients.find((c) => c.id === a.clientId)?.name || "Klient";
function recipients(db, a) {
  return db.accounts.filter((x) => !x.disabled && x.id !== accountOf(db, a)?.id && (a.role === "admin" || x.role === "admin" || a.role === "trainer" && x.role === "client" && db.clients.some((c) => c.id === x.clientId && c.trainerId === a.trainerId) || a.role === "client" && x.role === "trainer" && db.clients.some((c) => c.id === a.clientId && c.trainerId === x.trainerId)));
}
function notifications(db, a) {
  const welcome = db.messages.findIndex((m) => m.clientId === a.clientId && ["Witaj w ACO!", "Witamy w ACO!"].includes(m.title));
  if (a.role === "client" && !db.clients.some((c) => c.id === a.clientId && c.active)) return [];
  const existing = db.messages.filter((m, index) => a.role === "admin" ? m.target === "admin" : m.target !== "admin" && (a.role === "client" ? m.clientId === a.clientId && welcome >= 0 && index <= welcome : m.target !== "client" && m.title !== "Mo\u017Cesz aktywowa\u0107 konto" && !!m.clientId && db.clients.some((c) => c.id === m.clientId && c.trainerId === a.trainerId)));
  if (a.role !== "admin") return existing;
  return [...db.clients.filter((c) => !c.active).map((c) => ({ id: "activation-" + c.id, title: c.invited ? "Klient nie aktywowa\u0142 konta" : "Klient czeka na zatwierdzenie", body: `${c.name} \xB7 trener: ${db.trainers.find((t) => t.id === c.trainerId)?.name || "-"}`, at: db.now, read: false, target: "admin" })), ...db.holds.filter((h) => h.status !== "paid").map((h) => ({ id: "payment-" + h.id, title: h.expires <= db.now ? "Up\u0142yn\u0105\u0142 termin p\u0142atno\u015Bci" : "Rezerwacja oczekuje na p\u0142atno\u015B\u0107", body: `${db.clients.find((c) => c.id === h.clientId)?.name} \xB7 termin: ${new Date(h.expires).toLocaleString("pl-PL")}`, at: h.expires, read: false, target: "admin" })), ...existing];
}
function manage(source, a, cmd) {
  const db = structuredClone(source), me = accountOf(db, a);
  if (!me) throw Error("Zaloguj si\u0119.");
  if (cmd.type === "updateProfile") {
    const email = cmd.email.trim().toLowerCase();
    if (!cmd.name.trim() || !/^\S+@\S+\.\S+$/.test(email)) throw Error("Podaj imi\u0119, nazwisko i poprawny e-mail.");
    if (db.accounts.some((x) => x.id !== me.id && x.email === email) || db.clients.some((c) => c.id !== me.clientId && c.email.toLowerCase() === email)) throw Error("Ten e-mail jest u\u017Cywany przez inne konto.");
    if (cmd.photo && (!/^data:image\/(png|jpeg|webp);base64,/.test(cmd.photo) || cmd.photo.length > 29e5)) throw Error("Nieprawid\u0142owy plik zdj\u0119cia.");
    me.email = email;
    me.name = cmd.name.trim();
    me.phone = cmd.phone.trim();
    me.photo = cmd.photo;
    const person = a.role === "trainer" ? db.trainers.find((t) => t.id === a.trainerId) : a.role === "client" ? db.clients.find((c) => c.id === a.clientId) : void 0;
    if (person) {
      person.name = me.name;
      person.phone = me.phone;
      person.photo = me.photo;
      if ("email" in person) person.email = email;
    }
    db.audit.unshift({ id: uid(), at: db.now, text: "Zaktualizowano w\u0142asny profil" });
    return db;
  }
  if (cmd.type === "sendLetter") {
    const allowed = recipients(db, a);
    const targets = cmd.to.startsWith("group:") ? allowed.filter((x) => cmd.to === "group:clients" ? x.role === "client" : a.role === "admin" && (cmd.to === "group:all" || cmd.to === "group:trainers" && x.role === "trainer")) : allowed.filter((x) => x.id === cmd.to);
    if (!targets.length) throw Error("Brak uprawnionych odbiorc\xF3w.");
    if (!cmd.subject.trim() || !cmd.body.trim()) throw Error("Wpisz temat i tre\u015B\u0107.");
    for (const to of targets) (db.letters ??= []).unshift({ id: uid(), from: me.id, to: to.id, fromName: accountName(db, me), toName: accountName(db, to), subject: cmd.subject.trim(), body: cmd.body.trim(), at: db.now, read: false });
    return db;
  }
  if (cmd.type === "readLetter") {
    const m = db.letters?.find((m2) => m2.id === cmd.id && m2.to === me.id);
    if (!m) throw Error("Brak dost\u0119pu.");
    m.read = true;
    return db;
  }
  if (cmd.type === "readNotice") {
    if (!notifications(db, a).some((n) => n.id === cmd.id)) throw Error("Brak dost\u0119pu.");
    db.noticeReads ??= {};
    db.noticeReads[me.id] = [.../* @__PURE__ */ new Set([...db.noticeReads[me.id] || [], cmd.id])];
    return db;
  }
  if (a.role !== "admin") throw Error("Tylko administrator mo\u017Ce wykona\u0107 t\u0119 operacj\u0119.");
  if (cmd.type === "birthDate") {
    const c = db.clients.find((c2) => c2.id === cmd.id);
    if (!c || !/^\d{4}-\d{2}-\d{2}$/.test(cmd.value) || cmd.value < "1900-01-01" || cmd.value > dateOf(new Date(db.now)) || (/* @__PURE__ */ new Date(cmd.value + "T12:00:00Z")).toISOString().slice(0, 10) !== cmd.value) throw Error("Podaj poprawn\u0105 dat\u0119 urodzenia.");
    c.birthDate = cmd.value;
  } else if (cmd.type === "deleteTrainer") {
    const t = db.trainers.find((t2) => t2.id === cmd.id && !t2.deleted);
    if (!t) throw Error("Nie znaleziono trenera.");
    if (db.clients.some((c) => c.trainerId === t.id)) throw Error("Trener ma klient\xF3w. Najpierw przypisz ich innemu prowadz\u0105cemu.");
    if (db.sessions.some((s) => s.trainerId === t.id && s.status === "scheduled") || db.holds.some((h) => h.trainerId === t.id && h.status === "active" && h.expires > db.now)) throw Error("Trener ma nierozliczone wizyty lub rezerwacje. Najpierw je rozlicz albo przeka\u017C innemu trenerowi.");
    t.deleted = true;
    db.accounts.filter((a2) => a2.trainerId === t.id).forEach((a2) => a2.disabled = true);
  } else if (cmd.type === "transferClient") {
    const c = db.clients.find((c2) => c2.id === cmd.clientId), t = db.trainers.find((t2) => t2.id === cmd.trainerId && !t2.deleted);
    if (!c || !t || c.trainerId === t.id) throw Error("Wybierz innego trenera prowadz\u0105cego.");
    if (c.prescribed && t.products && !t.products.includes(c.service)) throw Error("Nowy trener nie prowadzi produktu klienta.");
    const old = c.trainerId;
    const sessions = db.sessions.filter((s) => s.clientId === c.id && s.trainerId === old && s.status === "scheduled" && at(s.date, s.hour) > new Date(db.now));
    const holds = db.holds.filter((h) => h.clientId === c.id && h.status === "active" && h.expires > db.now);
    for (const s of sessions) {
      if (!available(db, t.id, s.date, s.hour, c.id, s.id) || s.kind === "consultation" && !available(db, t.id, s.date, s.hour + 1, c.id, s.id)) throw Error(`Nowy trener ma zaj\u0119ty termin ${s.date} ${s.hour}:00.`);
    }
    for (const h of holds) for (const d of h.dates) if (!available(db, t.id, d.date, d.hour, c.id, void 0, h.id)) throw Error("Nowy trener ma kolizj\u0119 z rezerwacj\u0105 klienta.");
    c.trainerId = t.id;
    sessions.forEach((s) => s.trainerId = t.id);
    holds.forEach((h) => h.trainerId = t.id);
  } else throw Error("Nieznana operacja.");
  db.audit.unshift({ id: uid(), at: db.now, text: cmd.type === "transferClient" ? "Zmieniono trenera prowadz\u0105cego klienta" : cmd.type === "deleteTrainer" ? "Usuni\u0119to trenera z zespo\u0142u" : "Uzupe\u0142niono dat\u0119 urodzenia klienta" });
  return db;
}
var managementTypes = ["updateProfile", "transferClient", "deleteTrainer", "birthDate", "sendLetter", "readLetter", "readNotice"];

// server/access.ts
function identityAccount(db, userId) {
  const account = db.accounts.find((a) => a.id === userId && !a.disabled);
  if (!account) throw Error("Brak dost\u0119pu do konta.");
  if (account.role === "client" && !db.clients.some((c) => c.id === account.clientId && c.active)) throw Error("Konto oczekuje na aktywacj\u0119.");
  if (account.role === "trainer" && !db.trainers.some((t) => t.id === account.trainerId && !t.deleted)) throw Error("Brak dost\u0119pu do konta.");
  return account;
}
function safeAccount(a, own) {
  return {
    id: a.id,
    role: a.role,
    email: a.email,
    name: a.name,
    phone: own ? a.phone : void 0,
    photo: a.photo,
    trainerId: a.trainerId,
    clientId: a.clientId,
    ...own ? { mustChangePassword: !!a.mustChangePassword } : {}
  };
}
function projectState(source, userId) {
  const me = identityAccount(source, userId), actor = actorFor(me), admin = me.role === "admin";
  const managed = new Set(source.clients.filter((c) => canSee(source, actor, c)).map((c) => c.id));
  const sessions = source.sessions.filter((s) => managed.has(s.clientId) || me.role === "trainer" && s.trainerId === me.trainerId && !s.substituteId && endAt(s) <= new Date(source.now));
  const historical = new Set(sessions.map((s) => s.clientId));
  const trainers = new Set(sessions.map((s) => s.trainerId));
  for (const c of source.clients) if (managed.has(c.id)) trainers.add(c.trainerId);
  if (me.trainerId) trainers.add(me.trainerId);
  const letters = (source.letters || []).filter((m) => m.from === me.id || m.to === me.id);
  const contacts = /* @__PURE__ */ new Set([me.id, ...recipients(source, actor).map((a) => a.id)]);
  for (const m of letters) {
    contacts.add(m.from);
    contacts.add(m.to);
  }
  const out = {
    version: 1,
    now: source.now,
    accounts: source.accounts.filter((a) => contacts.has(a.id)).map((a) => safeAccount(a, a.id === me.id)),
    clients: source.clients.filter((c) => managed.has(c.id) || historical.has(c.id)).map((c) => managed.has(c.id) ? {
      id: c.id,
      name: c.name,
      email: c.email,
      birthDate: c.birthDate,
      phone: c.phone,
      trainerId: c.trainerId,
      active: c.active,
      invited: c.invited,
      service: c.service,
      intensity: c.intensity,
      prescribed: c.prescribed,
      answers: [...c.answers],
      photo: c.photo
    } : { id: c.id, name: c.name, email: "", phone: "", trainerId: "", active: false, invited: false, service: c.service, intensity: 0, prescribed: false, answers: [] }),
    trainers: source.trainers.filter((t) => admin || trainers.has(t.id) || !t.deleted).map((t) => {
      const own = admin || t.id === me.trainerId;
      return {
        id: t.id,
        name: t.name,
        photo: t.photo,
        deleted: t.deleted,
        products: t.products,
        days: [...t.days],
        hours: [...t.hours],
        weeklyHours: structuredClone(t.weeklyHours),
        rate: own ? t.rate : 0,
        ...own ? { productRates: structuredClone(t.productRates), productRateHistory: structuredClone(t.productRateHistory), rates: structuredClone(t.rates), phone: t.phone, pesel: t.pesel, student: t.student, address: t.address, taxOffice: t.taxOffice } : {}
      };
    }),
    sessions: sessions.map((s) => ({
      id: s.id,
      clientId: s.clientId,
      trainerId: s.trainerId,
      packageId: s.packageId,
      date: s.date,
      hour: s.hour,
      kind: s.kind,
      status: s.status,
      locationId: s.locationId,
      consultationPrice: s.consultationPrice,
      publicNote: s.publicNote,
      privateNote: me.role === "client" ? "" : s.privateNote,
      comments: s.comments.map((c) => ({ id: c.id, author: c.author, text: c.text, at: c.at })),
      original: s.original,
      substituteId: s.substituteId,
      ...admin || s.trainerId === me.trainerId ? { rate: s.rate, earned: s.earned } : {}
    })),
    packages: source.packages.filter((p) => managed.has(p.clientId)).map((p) => structuredClone(p)),
    holds: source.holds.filter((h) => managed.has(h.clientId)).map((h) => structuredClone(h)),
    sales: source.sales.filter((s) => admin || me.role === "client" && s.clientId === me.clientId).map((s) => structuredClone(s)),
    substitutions: source.substitutions.filter((s) => managed.has(s.clientId) && s.until > source.now).map((s) => structuredClone(s)),
    blocks: occupiedSlots(source, new Set(sessions.map((s) => s.id)), new Set(source.holds.filter((h) => managed.has(h.clientId)).map((h) => h.id)), managed),
    messages: source.messages.filter((m) => notifications(source, actor).some((n) => n.id === m.id)).map((m) => structuredClone(m)),
    letters: letters.map((m) => structuredClone(m)),
    noticeReads: { [me.id]: [...source.noticeReads?.[me.id] || []] },
    locations: structuredClone(source.locations),
    audit: admin ? structuredClone(source.audit) : [],
    settings: structuredClone(source.settings),
    productCopies: structuredClone(source.productCopies),
    promotions: source.promotions?.filter((p) => admin || me.role === "client" && p.kind === "email" && p.value === me.email.toLowerCase()).map((p) => structuredClone(p)),
    extraHours: source.extraHours?.filter((h) => admin || h.trainerId === me.trainerId).map((h) => structuredClone(h))
  };
  out.accounts.sort((a, b) => Number(b.id === me.id) - Number(a.id === me.id));
  return out;
}
function publicState(source) {
  return {
    version: 1,
    now: source.now,
    accounts: [],
    clients: [],
    sessions: [],
    packages: [],
    holds: [],
    messages: [],
    sales: [],
    substitutions: [],
    audit: [],
    letters: [],
    trainers: source.trainers.filter((t) => !t.deleted).map((t) => ({ id: t.id, name: t.name, photo: t.photo, products: t.products, days: [...t.days], hours: [...t.hours], weeklyHours: structuredClone(t.weeklyHours), rate: 0 })),
    locations: structuredClone(source.locations),
    settings: structuredClone(source.settings),
    productCopies: structuredClone(source.productCopies),
    blocks: occupiedSlots(source, /* @__PURE__ */ new Set())
  };
}
function occupiedSlots(source, visibleSessions, visibleHolds = /* @__PURE__ */ new Set(), visibleClients = /* @__PURE__ */ new Set()) {
  const out = source.blocks.map((b) => ({ ...b }));
  for (const s of source.sessions) if (!visibleSessions.has(s.id) && s.status === "scheduled") for (let h = s.hour; h < s.hour + (s.kind === "consultation" ? 2 : 1); h++) out.push({ id: `busy:${s.trainerId}:${s.date}:${h}`, trainerId: s.trainerId, date: s.date, hour: h, visibility: "busy" });
  for (const h of source.holds) if (!visibleHolds.has(h.id) && h.status === "active" && h.expires > source.now) for (const d of h.dates) out.push({ id: `busy:${h.trainerId}:${d.date}:${d.hour}`, trainerId: h.trainerId, date: d.date, hour: d.hour, visibility: "busy" });
  const today = dateOf(new Date(source.now));
  const days = visibleClients.size ? 366 : rules(source).consultationDays + 1;
  for (const p of source.packages) if (!visibleClients.has(p.clientId) && p.protectionUntil > today) {
    const trainerId = source.clients.find((c) => c.id === p.clientId)?.trainerId;
    if (!trainerId) continue;
    for (let n = 0; n < days; n++) {
      const date2 = dayAdd(today, n);
      if (date2 < p.start) continue;
      for (const slot of p.slots) if (slot.day === dayIndex(date2) && !source.sessions.some((s) => s.packageId === p.id && (s.date === date2 && s.hour === slot.hour && s.status.startsWith("cancelled") || s.original === `${date2} ${String(slot.hour).padStart(2, "0")}:00`))) out.push({ id: `protected:${trainerId}:${date2}:${slot.hour}`, trainerId, date: date2, hour: slot.hour, visibility: "busy" });
    }
  }
  return out;
}

// server/commands.ts
var text = (max, min = 0) => (v) => typeof v === "string" && v.length >= min && v.length <= max;
var number = (min, max, integer = false) => (v) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v));
var choice = (...values) => (v) => values.includes(v);
var optional = (check) => (v) => v === void 0 || check(v);
var array = (check, max) => (v) => Array.isArray(v) && v.length <= max && v.every(check);
var object = (fields2) => (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).every((k) => Object.hasOwn(fields2, k)) && Object.entries(fields2).every(([k, check]) => check(v[k]));
var id = text(100, 1);
var day = number(0, 6, true);
var hour = number(0, 23, true);
var service = choice("personal", "physio");
var date = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= "1900-01-01" && v <= "2200-12-31" && Number.isFinite(Date.parse(v + "T12:00:00Z")) && (/* @__PURE__ */ new Date(v + "T12:00:00Z")).toISOString().slice(0, 10) === v;
var dates = array(object({ date, hour, original: optional(text(100)) }), 156);
var rules2 = object(Object.fromEntries(Object.keys(defaultRules).map((k) => [k, number(1, k.endsWith("Weeks") ? 52 : 366, true)])));
var prices = object({ "1": number(0.01, 1e6), "2": number(0.01, 1e6), "3": number(0.01, 1e6) });
var photo = (v) => typeof v === "string" && (v === "" || v.length <= 29e5 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v));
var fields = {
  saveLocation: { id, name: text(200, 1), address: text(500) },
  sessionLocation: { id, locationId: id },
  updateProfile: { name: text(200, 1), email: text(254, 3), phone: text(40), photo },
  availability: { trainerId: id, days: array(day, 7), hours: array(hour, 24), weeklyHours: optional(object(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [String(i), optional(array(hour, 24))])))) },
  requestPayment: { id, code: optional(text(100)) },
  confirmConsultation: { id },
  transferClient: { clientId: id, trainerId: id },
  deleteTrainer: { id },
  birthDate: { id, value: date },
  sendLetter: { to: id, subject: text(200, 1), body: text(2e4, 1) },
  readLetter: { id },
  readNotice: { id },
  outcome: { id, status: choice("completed", "no_show", "cancelled_early", "cancelled_late", "cancelled_trainer") },
  notes: { id, publicNote: text(2e4), privateNote: text(2e4) },
  comment: { id, text: text(1e4, 1) },
  reschedule: { id, date, hour },
  activate: { id, service, intensity: number(1, 3, true) },
  hold: { clientId: id, start: date, slots: array(object({ day, hour }), 3), dates },
  payHold: { id, code: optional(text(100)) },
  editHold: { id, dates },
  makeup: { packageId: id, date, hour },
  substitute: { clientId: id, trainerId: id, from: date, to: date },
  extend: { packageId: id, days: number(1, 366, true) },
  validity: { packageId: id, date },
  freeze: { packageId: id },
  block: { trainerId: id, date, hour, visibility: optional(choice("busy", "hidden")) },
  unblock: { id },
  settings: { personal: number(0.01, 1e6), physio: number(0.01, 1e6), consultation: number(0.01, 1e6), cancelHours: number(1, 8760, true), rules: optional(rules2), packagePrices: optional(object({ personal: prices, physio: prices })) },
  rate: { trainerId: id, rate: number(0.01, 1e6) },
  productCopy: { service, copy: object({ name: text(200, 1), subtitle: text(2e3, 1), bullets: array(text(1e3, 1), 20) }) },
  promotion: { promotion: object({ kind: choice("email", "code"), value: text(254, 1), percent: number(1, 100), maxUses: number(0, 1e6, true), expires: (v) => v === "" || date(v), active: choice(true, false) }) },
  disablePromotion: { id },
  extraHours: { trainerId: id, month: (v) => typeof v === "string" && /^20\d\d-(0[1-9]|1[0-2])$/.test(v), hours: number(0.01, 744), rate: number(0.01, 1e6), description: text(2e3, 1) }
};
function parseCommand(value) {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string" || !Object.hasOwn(fields, value.type) || !object({ type: choice(value.type), ...fields[value.type] })(value)) throw Error("Nieprawid\u0142owa operacja lub dane formularza.");
  return structuredClone(value);
}
function applyCommand(source, userId, input, serverNow) {
  if (!Number.isFinite(Date.parse(serverNow))) throw Error("Nieprawid\u0142owy czas serwera.");
  const db = structuredClone(source);
  db.now = new Date(serverNow).toISOString();
  const me = identityAccount(db, userId);
  if (me.mustChangePassword) throw Error("Najpierw zmie\u0144 has\u0142o tymczasowe.");
  const cmd = parseCommand(input);
  if (cmd.type === "payHold" && me.role !== "admin") throw Error("Op\u0142at\u0119 mo\u017Ce potwierdzi\u0107 wy\u0142\u0105cznie administrator.");
  db.accounts.sort((a, b) => Number(b.id === userId) - Number(a.id === userId));
  const actor = actorFor(me);
  if (cmd.type === "requestPayment") {
    const hold = db.holds.find((h) => h.id === cmd.id && h.clientId === me.clientId && h.status === "active" && h.expires > db.now);
    if (me.role !== "client" || !hold) throw Error("Rezerwacja jest niedost\u0119pna.");
    quote(db, hold.clientId, hold.service, hold.intensity, cmd.code);
    hold.paymentRequest = { code: cmd.code || "", at: db.now };
    db.messages.unshift({ id: uid(), title: "Pro\u015Bba o rozliczenie pakietu", body: `${db.clients.find((c) => c.id === hold.clientId)?.name} \xB7 oczekuje na potwierdzenie wp\u0142aty.`, at: db.now, target: "admin", read: false });
    return db;
  }
  if (cmd.type === "confirmConsultation") {
    if (me.role !== "admin") throw Error("Op\u0142at\u0119 potwierdza administrator.");
    const session = db.sessions.find((s) => s.id === cmd.id && s.kind === "consultation");
    if (!session || db.sales.some((s) => s.id === "consultation:" + session.id)) throw Error("Konsultacja zosta\u0142a ju\u017C rozliczona lub nie istnieje.");
    db.sales.push({ id: "consultation:" + session.id, sessionId: session.id, clientId: session.clientId, label: "Konsultacja", amount: session.consultationPrice ?? db.settings.consultation, date: db.now, status: "paid" });
    return db;
  }
  if (cmd.type === "payHold") cmd.code = cmd.code || db.holds.find((h) => h.id === cmd.id)?.paymentRequest?.code;
  return managementTypes.includes(cmd.type) ? manage(db, actor, cmd) : execute(db, actor, cmd);
}
function parseRegistration(value) {
  if (!object({ type: choice("register"), name: text(200, 1), email: text(254, 3), birthDate: date, phone: text(40, 1), trainerId: id, date, hour, answers: array(text(2e3), 20) })(value)) throw Error("Uzupe\u0142nij poprawnie formularz konsultacji.");
  return structuredClone(value);
}
function parseTrainer(value) {
  if (!object({ id: optional(id), name: text(200, 1), email: text(254, 3), products: array(service, 2), productRates: object({ personal: number(0, 1e6), physio: number(0, 1e6) }), days: array(day, 7), hours: array(hour, 24), password: text(200), phone: text(40), pesel: text(11), student: choice(true, false), address: text(500), taxOffice: text(200), photo })(value)) throw Error("Nieprawid\u0142owe dane trenera.");
  return structuredClone(value);
}

// server/relational-store.ts
var ruleColumns = { renewalDays: "renewal_days", cycleWeeks: "cycle_weeks", validWeeks: "validity_weeks", coachHoldHours: "coach_hold_hours", checkoutMinutes: "checkout_minutes", protectionDays: "protection_days", consultationDays: "consultation_days", startDays: "start_days", substituteHours: "substitute_hours", freezeDays: "freeze_days" };
var money = (n) => n === void 0 ? null : Math.round(n * 100);
var iso = (value) => value ? new Date(value).toISOString() : void 0;
var wall = (value) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
var starts = (date2, hour2) => at(date2, hour2).toISOString();
var original = (v) => v ? starts(v.slice(0, 10), Number(v.slice(11, 13))) : null;
var ruleData = (r) => Object.fromEntries(Object.entries(ruleColumns).map(([key, col]) => [col, r[key]]));
var readRules = (r) => Object.fromEntries(Object.entries(ruleColumns).map(([key, col]) => [key, r[col] ?? defaultRules[key]]));
var sourceRows = /* @__PURE__ */ new WeakMap();
var group = (rows, table) => rows.filter((r) => r.table === table).map((r) => r.data);
function encodeRelational(db, baseline = sourceRows.get(db) || []) {
  const previous = (table, key) => baseline.find((r) => r.table === table && r.key === key)?.data;
  const out = [];
  const add = (table, data, key = String(data.id ?? data.session_id ?? data.trainer_id)) => out.push({ table, key, data });
  const accountProfile = (id2) => {
    const a = db.accounts.find((a2) => a2.id === id2);
    return a?.clientId || a?.trainerId || a?.id;
  };
  for (const a of db.accounts) {
    const c = db.clients.find((c2) => c2.id === a.clientId), t = db.trainers.find((t2) => t2.id === a.trainerId), pid = a.clientId || a.trainerId || a.id;
    add("aco_profiles", { id: pid, auth_user_id: a.id, name: c?.name || t?.name || a.name || "Administrator ACO!", email: a.email, phone: c?.phone || t?.phone || a.phone || "", avatar_path: c?.photo || t?.photo || a.photo || null, must_change_password: !!a.mustChangePassword });
    add("aco_accounts", { id: a.id, profile_id: pid, role: a.role, enabled: !a.disabled });
  }
  for (const t of db.trainers) {
    add("aco_trainers", { id: t.id, deleted_at: t.deleted ? previous("aco_trainers", t.id)?.deleted_at || db.now : null });
    add("aco_trainer_payroll", { trainer_id: t.id, pesel: t.pesel || null, student: !!t.student, address: t.address || "", tax_office: t.taxOffice || "" });
    for (const product of t.products || ["personal"]) add("aco_trainer_products", { id: t.id + ":" + product, trainer_id: t.id, product_id: product });
    const history = t.productRateHistory || t.rates?.map((r) => ({ from: r.from, personal: r.rate, physio: r.rate })) || [{ from: "1900-01-01", ...t.productRates || { personal: t.rate, physio: t.rate } }];
    for (const r of history) for (const product of ["personal", "physio"]) add("aco_trainer_rates", { id: [t.id, product, r.from].join(":"), trainer_id: t.id, product_id: product, effective_from: r.from, rate_grosz: money(r[product]) });
    for (let day2 = 0; day2 < 7; day2++) for (const hour2 of trainerHours(t, day2)) add("aco_availability", { id: [t.id, day2, hour2].join(":"), trainer_id: t.id, weekday: day2, hour: hour2 });
  }
  for (const c of db.clients) {
    add("aco_clients", { id: c.id, lead_trainer_id: c.trainerId, birth_date: c.birthDate || null, status: c.active ? "active" : c.invited ? "approved" : "pending", product: c.prescribed ? c.service : null, intensity: c.prescribed ? c.intensity : null, approved_at: c.invited ? previous("aco_clients", c.id)?.approved_at || db.now : null });
    c.answers.forEach((answer, position) => add("aco_client_answers", { id: c.id + ":" + position, client_id: c.id, position, answer }));
  }
  for (const service2 of ["personal", "physio"]) {
    const copy = productCopy(db, service2);
    add("aco_products", { id: service2, name: copy.name, subtitle: copy.subtitle, bullets: copy.bullets });
    for (const intensity of [1, 2, 3]) add("aco_product_prices", { id: service2 + ":" + intensity, product_id: service2, intensity, amount_grosz: money(packagePrice(db, service2, intensity)) });
  }
  for (const l of locationsOf(db)) add("aco_locations", { id: l.id, name: l.name, address: l.address });
  const settings = { consultation_grosz: money(db.settings.consultation), personal_grosz: money(db.settings.personal), physio_grosz: money(db.settings.physio), cancellation_hours: db.settings.cancelHours, ...ruleData(rules(db)) };
  add("aco_settings", { id: "company", ...settings });
  for (const p of db.promotions || []) add("aco_promotions", { id: p.id, kind: p.kind, value: p.value, percent: p.percent, max_uses: p.kind === "code" ? p.maxUses : null, used: p.used, expires_on: p.expires || null, active: p.active });
  for (const p of db.packages) {
    add("aco_packages", { id: p.id, client_id: p.clientId, product: p.service, intensity: p.intensity, count: p.count, starts_on: p.start, cycle_end: p.cycleEnd, valid_until: p.validUntil, protection_until: p.protectionUntil, price_grosz: money(p.price), base_price_grosz: money(p.basePrice ?? p.price), discount_percent: p.discountPercent || 0, promotion_id: p.promotionId || null, frozen: !!p.frozen });
    for (const s of p.slots) add("aco_package_slots", { id: p.id + ":" + s.day, package_id: p.id, weekday: s.day, hour: s.hour });
  }
  for (const h of db.holds) {
    add("aco_holds", { id: h.id, client_id: h.clientId, trainer_id: h.trainerId, product_id: h.service, intensity: h.intensity, starts_on: h.start, expires_at: iso(h.expires), price_grosz: money(h.price), status: h.status, kind: h.type, payment_requested_at: iso(h.paymentRequest?.at) || null, promotion_code: h.paymentRequest?.code ?? null });
    for (const d of h.dates) add("aco_hold_dates", { id: [h.id, d.date, d.hour].join(":"), hold_id: h.id, starts_at: starts(d.date, d.hour), original_starts_at: original(d.original) });
    for (const s of h.slots) add("aco_hold_slots", { id: h.id + ":" + s.day, hold_id: h.id, weekday: s.day, hour: s.hour });
    add("aco_hold_terms", { id: h.id, hold_id: h.id, ...ruleData(h.terms || defaultRules) });
  }
  for (const s of db.substitutions) add("aco_substitutions", { id: s.id, client_id: s.clientId, trainer_id: s.trainerId, expires_at: iso(s.until), revoked_at: null });
  for (const s of db.sessions) {
    const start = starts(s.date, s.hour);
    add("aco_sessions", { location_id: s.locationId || defaultLocation.id, id: s.id, client_id: s.clientId, trainer_id: s.trainerId, substitution_id: s.substituteId || null, package_id: s.packageId || null, kind: s.kind, starts_at: start, ends_at: new Date(+new Date(start) + (s.kind === "consultation" ? 90 : 60) * 6e4).toISOString(), status: s.status, original_starts_at: original(s.original), consultation_grosz: money(s.consultationPrice) });
    if (s.earned !== void 0) add("aco_earnings", { id: s.id, trainer_id: s.trainerId, session_id: s.id, kind: s.kind, hours: s.kind === "consultation" ? 1.5 : 1, rate_grosz: money(s.rate || 0), amount_grosz: money(s.earned), month: s.date.slice(0, 7) + "-01", description: "" });
    add("aco_public_notes", { session_id: s.id, body: s.publicNote });
    add("aco_trainer_notes", { session_id: s.id, body: s.privateNote });
    for (const c of s.comments) add("aco_comments", { id: c.id, session_id: s.id, author_label: c.author, body: c.text, created_at: iso(c.at) });
  }
  for (const b of db.blocks) if (!b.id.startsWith("busy:") && !b.id.startsWith("protected:")) add("aco_blackouts", { id: b.id, trainer_id: b.trainerId, starts_at: starts(b.date, b.hour), visibility: b.visibility || "busy" });
  for (const s of db.sales) add("aco_sales", { id: s.id, client_id: s.clientId, package_id: s.packageId || null, session_id: s.sessionId || null, label: s.label, amount_grosz: money(s.amount), status: s.status, settled_at: iso(s.date) });
  for (const h of db.extraHours || []) add("aco_earnings", { id: h.id, trainer_id: h.trainerId, session_id: null, kind: "company", hours: h.hours, rate_grosz: money(h.rate), amount_grosz: money(h.amount), month: h.month + "-01", description: h.description });
  for (const m of db.letters || []) add("aco_messages", { id: m.id, sender_id: accountProfile(m.from), recipient_id: accountProfile(m.to), subject: m.subject, body: m.body, created_at: iso(m.at), read_at: m.read ? previous("aco_messages", m.id)?.read_at || iso(db.now) : null });
  for (const m of db.messages) add("aco_events", { id: m.id, client_id: m.clientId || null, title: m.title, body: m.body, audience: m.target, created_at: iso(m.at) });
  for (const a of db.audit) add("aco_activity", { id: a.id, description: a.text, created_at: iso(a.at) });
  for (const [account, notices] of Object.entries(db.noticeReads || {})) for (const notice of notices) {
    const profile = accountProfile(account);
    if (profile) add("aco_notice_reads", { id: profile + ":" + notice, profile_id: profile, notice_id: notice });
  }
  return out;
}
function decodeRelational(snapshot) {
  const rows = snapshot.rows, get = (table) => group(rows, table), profiles = get("aco_profiles"), accounts = get("aco_accounts");
  const profile = (id2) => profiles.find((p) => p.id === id2) || get("aco_trainer_directory").find((p) => p.id === id2) || {};
  const accountId = (profileId) => accounts.find((a) => a.profile_id === profileId)?.id || profileId;
  const setting = get("aco_settings")[0] || {};
  const db = { version: 1, now: new Date(snapshot.now).toISOString(), locations: get("aco_locations").map((l) => ({ id: l.id, name: l.name, address: l.address })), accounts: [], clients: [], trainers: [], sessions: [], packages: [], holds: [], messages: [], sales: [], substitutions: [], audit: [], blocks: [], letters: [], noticeReads: {}, promotions: [], extraHours: [], productCopies: {}, settings: { personal: (setting.personal_grosz ?? 18e3) / 100, physio: (setting.physio_grosz ?? 22e3) / 100, consultation: (setting.consultation_grosz ?? 25e3) / 100, cancelHours: setting.cancellation_hours ?? 24, rules: readRules(setting), packagePrices: { personal: {}, physio: {} } } };
  for (const a of accounts) {
    const p = profile(a.profile_id);
    db.accounts.push({ id: a.id, email: p.email || "", name: p.name, phone: p.phone, photo: p.avatar_path || void 0, role: a.role, disabled: !a.enabled, mustChangePassword: !!p.must_change_password, ...a.role === "client" ? { clientId: a.profile_id } : a.role === "trainer" ? { trainerId: a.profile_id } : {} });
  }
  for (const t of get("aco_trainers")) {
    const p = profile(t.id), pay = get("aco_trainer_payroll").find((r) => r.trainer_id === t.id) || {}, availability = get("aco_availability").filter((r) => r.trainer_id === t.id), rates = get("aco_trainer_rates").filter((r) => r.trainer_id === t.id);
    const history = [...new Set(rates.map((r) => r.effective_from))].sort().map((from) => ({ from, personal: (rates.find((r) => r.effective_from === from && r.product_id === "personal")?.rate_grosz || 0) / 100, physio: (rates.find((r) => r.effective_from === from && r.product_id === "physio")?.rate_grosz || 0) / 100 }));
    const effective = history.filter((r) => r.from <= dateOf(new Date(db.now))).at(-1) || { personal: 0, physio: 0 };
    db.trainers.push({ id: t.id, name: p.name || "", photo: p.avatar_path || void 0, deleted: !!t.deleted_at, days: [...new Set(availability.map((r) => r.weekday))].sort(), hours: [...new Set(availability.map((r) => r.hour))].sort((a, b) => a - b), weeklyHours: Object.fromEntries(Array.from({ length: 7 }, (_, day2) => [day2, availability.filter((r) => r.weekday === day2).map((r) => r.hour).sort((a, b) => a - b)])), products: get("aco_trainer_products").filter((r) => r.trainer_id === t.id).map((r) => r.product_id), productRateHistory: history, productRates: { personal: effective.personal, physio: effective.physio }, rate: effective.personal, phone: p.phone || "", pesel: pay.pesel || "", student: !!pay.student, address: pay.address || "", taxOffice: pay.tax_office || "" });
  }
  for (const c of get("aco_clients")) {
    const p = profile(c.id);
    db.clients.push({ id: c.id, name: p.name || "", email: p.email || "", phone: p.phone || "", photo: p.avatar_path || void 0, birthDate: c.birth_date, trainerId: c.lead_trainer_id, active: c.status === "active", invited: ["approved", "active"].includes(c.status), service: c.product || db.trainers.find((t) => t.id === c.lead_trainer_id)?.products?.[0] || "personal", intensity: c.intensity || 2, prescribed: !!c.product, answers: get("aco_client_answers").filter((r) => r.client_id === c.id).sort((a, b) => a.position - b.position).map((r) => r.answer) });
  }
  for (const p of get("aco_products")) db.productCopies[p.id] = { name: p.name, subtitle: p.subtitle, bullets: p.bullets };
  for (const p of get("aco_product_prices")) db.settings.packagePrices[p.product_id][p.intensity] = p.amount_grosz / 100;
  for (const p of get("aco_promotions")) db.promotions.push({ id: p.id, kind: p.kind, value: p.value, percent: Number(p.percent), maxUses: p.max_uses || 0, used: p.used, expires: p.expires_on || "", active: p.active });
  for (const p of get("aco_packages")) db.packages.push({ id: p.id, clientId: p.client_id, service: p.product, intensity: p.intensity, count: p.count, start: p.starts_on, cycleEnd: p.cycle_end, validUntil: p.valid_until, protectionUntil: p.protection_until, price: p.price_grosz / 100, basePrice: p.base_price_grosz / 100, discountPercent: Number(p.discount_percent), promotionId: p.promotion_id || void 0, frozen: p.frozen, slots: get("aco_package_slots").filter((s) => s.package_id === p.id).map((s) => ({ day: s.weekday, hour: s.hour })) });
  for (const h of get("aco_holds")) db.holds.push({ id: h.id, clientId: h.client_id, trainerId: h.trainer_id, service: h.product_id, intensity: h.intensity, start: h.starts_on, expires: iso(h.expires_at), price: h.price_grosz / 100, status: h.status, type: h.kind, terms: readRules(get("aco_hold_terms").find((t) => t.hold_id === h.id) || {}), dates: get("aco_hold_dates").filter((d) => d.hold_id === h.id).map((d) => ({ date: wall(d.starts_at).slice(0, 10), hour: Number(wall(d.starts_at).slice(11, 13)), original: d.original_starts_at ? wall(d.original_starts_at) : void 0 })), slots: get("aco_hold_slots").filter((s) => s.hold_id === h.id).map((s) => ({ day: s.weekday, hour: s.hour })), paymentRequest: h.payment_requested_at ? { at: iso(h.payment_requested_at), code: h.promotion_code || "" } : void 0 });
  for (const s of get("aco_substitutions")) if (!s.revoked_at) db.substitutions.push({ id: s.id, clientId: s.client_id, trainerId: s.trainer_id, until: iso(s.expires_at) });
  for (const s of get("aco_sessions")) {
    const earning = get("aco_earnings").find((e) => e.session_id === s.id);
    db.sessions.push({ locationId: s.location_id || defaultLocation.id, id: s.id, clientId: s.client_id, trainerId: s.trainer_id, packageId: s.package_id || void 0, substituteId: s.substitution_id || void 0, kind: s.kind, status: s.status, date: wall(s.starts_at).slice(0, 10), hour: Number(wall(s.starts_at).slice(11, 13)), original: s.original_starts_at ? wall(s.original_starts_at) : void 0, consultationPrice: s.consultation_grosz == null ? void 0 : s.consultation_grosz / 100, rate: earning ? earning.rate_grosz / 100 : void 0, earned: earning ? earning.amount_grosz / 100 : void 0, publicNote: get("aco_public_notes").find((n) => n.session_id === s.id)?.body || "", privateNote: get("aco_trainer_notes").find((n) => n.session_id === s.id)?.body || "", comments: get("aco_comments").filter((c) => c.session_id === s.id).map((c) => ({ id: c.id, author: c.author_label || profile(c.author_id).name || "", text: c.body, at: iso(c.created_at) })) });
  }
  for (const b of get("aco_blackouts")) db.blocks.push({ id: b.id, trainerId: b.trainer_id, date: wall(b.starts_at).slice(0, 10), hour: Number(wall(b.starts_at).slice(11, 13)), visibility: b.visibility });
  for (const b of get("aco_busy_slots")) db.blocks.push({ id: "busy:" + b.trainer_id + ":" + b.starts_at, trainerId: b.trainer_id, date: wall(b.starts_at).slice(0, 10), hour: Number(wall(b.starts_at).slice(11, 13)), visibility: "busy" });
  for (const s of get("aco_sales")) db.sales.push({ id: s.id, clientId: s.client_id, packageId: s.package_id || void 0, sessionId: s.session_id || void 0, label: s.label, amount: s.amount_grosz / 100, status: s.status, date: iso(s.settled_at) });
  for (const e of get("aco_earnings")) if (e.kind === "company") db.extraHours.push({ id: e.id, trainerId: e.trainer_id, month: e.month.slice(0, 7), hours: Number(e.hours), rate: e.rate_grosz / 100, amount: e.amount_grosz / 100, description: e.description });
  for (const m of get("aco_messages")) db.letters.push({ id: m.id, from: accountId(m.sender_id), to: accountId(m.recipient_id), fromName: profile(m.sender_id).name || "", toName: profile(m.recipient_id).name || "", subject: m.subject, body: m.body, at: iso(m.created_at), read: !!m.read_at });
  for (const m of get("aco_events")) db.messages.push({ id: m.id, clientId: m.client_id || void 0, title: m.title, body: m.body, target: m.audience, at: iso(m.created_at), read: false });
  for (const r of get("aco_notice_reads")) (db.noticeReads[accountId(r.profile_id)] ??= []).push(r.notice_id);
  for (const a of get("aco_activity")) db.audit.push({ id: a.id, text: a.description, at: iso(a.created_at) });
  db.holds.sort((a, b) => b.expires.localeCompare(a.expires));
  db.messages.sort((a, b) => b.at.localeCompare(a.at));
  db.audit.sort((a, b) => b.at.localeCompare(a.at));
  db.letters.sort((a, b) => b.at.localeCompare(a.at));
  sourceRows.set(db, rows);
  return db;
}
function relationalChanges(before, after) {
  const baseline = sourceRows.get(before) || [], versions = new Map(baseline.map((r) => [r.table + ":" + r.key, r.version]));
  const old = new Map(encodeRelational(before, baseline).map((r) => [r.table + ":" + r.key, r]));
  const changes = [], removed = [];
  for (const r of encodeRelational(after, baseline)) {
    const k = r.table + ":" + r.key, prior = old.get(k);
    if (JSON.stringify(prior?.data) !== JSON.stringify(r.data)) changes.push({ ...r, version: versions.get(k) });
    old.delete(k);
  }
  for (const [key, r] of old) if (versions.has(key)) removed.push({ table: r.table, key: r.key, version: versions.get(key) });
  return { changes, removed };
}
function relationalCommitArgs(before, after, actorId, action) {
  const delta = relationalChanges(before, after), baseline = sourceRows.get(before) || [];
  const clients = /* @__PURE__ */ new Set(), trainers = /* @__PURE__ */ new Set();
  for (const r of [...delta.changes, ...delta.removed]) {
    const data = ("data" in r ? r.data : baseline.find((b) => b.table === r.table && b.key === r.key)?.data) || {};
    if (r.table === "aco_clients") clients.add(r.key);
    if (data.client_id) clients.add(data.client_id);
    if (r.table === "aco_trainers") trainers.add(r.key);
    if (data.trainer_id) trainers.add(data.trainer_id);
    if (data.package_id) {
      const p = after.packages.find((p2) => p2.id === data.package_id) || before.packages.find((p2) => p2.id === data.package_id);
      if (p) clients.add(p.clientId);
    }
    if (data.hold_id) {
      const h = after.holds.find((h2) => h2.id === data.hold_id) || before.holds.find((h2) => h2.id === data.hold_id);
      if (h) {
        clients.add(h.clientId);
        trainers.add(h.trainerId);
      }
    }
    if (data.session_id) {
      const s = after.sessions.find((s2) => s2.id === data.session_id) || before.sessions.find((s2) => s2.id === data.session_id);
      if (s) {
        clients.add(s.clientId);
        trainers.add(s.trainerId);
      }
    }
  }
  for (const db of [before, after]) for (const c of db.clients) if (clients.has(c.id) && c.trainerId) trainers.add(c.trainerId);
  const actor = before.accounts.find((a) => a.id === actorId), profile = actor?.clientId || actor?.trainerId || actorId;
  const calendar = ["register", "hold", "editHold", "payHold", "makeup", "reschedule", "outcome", "substitute", "transferClient", "block", "unblock", "freeze", "validity", "extend", "availability"].includes(action);
  const dependencies = baseline.filter((r) => r.table === "aco_accounts" && r.key === actorId || r.table === "aco_profiles" && r.key === profile || r.table === "aco_clients" && clients.has(r.key) || r.table === "aco_trainers" && trainers.has(r.key) || calendar && ["aco_settings", "aco_product_prices", "aco_promotions"].includes(r.table)).map(({ table, key, version }) => ({ table, key, version }));
  return { p_changes: delta.changes, p_removed: delta.removed, p_dependencies: dependencies, p_clients: [...clients].sort(), p_trainers: [...trainers].sort(), p_role: actor?.role || "registration", p_action: action };
}

// server/accounts.ts
async function publicAction(body, req, services) {
  const { rpc, auth, hash: hash2 } = services;
  if (!["publicState", "register", "activation"].includes(body.action)) throw Error("Nieznana operacja.");
  const ip = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
  const limit = body.action === "publicState" ? 120 : 5;
  if (!await rpc("aco_rate_limit", { p_key: await hash2(body.action + ":" + ip), p_max: limit, p_seconds: body.action === "publicState" ? 60 : 3600 })) throw Error("Zbyt wiele pr\xF3b. Spr\xF3buj ponownie p\xF3\u017Aniej.");
  const lookupEmail = body.action === "register" ? parseRegistration(body.command).email : body.action === "activation" && typeof body.email === "string" ? body.email : null;
  let snapshot = await rpc("aco_relational_public_load", { p_email: lookupEmail }), db = decodeRelational(snapshot);
  if (body.action === "publicState") return { accountId: "", revision: snapshot.revision, db: publicState(db) };
  if (body.action === "activation") {
    if (typeof body.email !== "string" || body.email.length > 254 || typeof body.birthDate !== "string") throw Error("Uzupe\u0142nij e-mail i dat\u0119 urodzenia.");
    const email2 = body.email.trim().toLowerCase();
    if (!await rpc("aco_rate_limit", { p_key: await hash2("activation-email:" + email2), p_max: 3, p_seconds: 3600 })) return { ok: true };
    const account = db.accounts.find((a) => a.email === email2 && a.role === "client" && !a.disabled), client = db.clients.find((c) => c.id === account?.clientId);
    if (client?.invited && client.birthDate === body.birthDate) {
      await auth("/recover?redirect_to=" + encodeURIComponent("https://acofitness.github.io/demo/panel.html?activation=1"), "POST", { email: email2 });
    }
    return { ok: true };
  }
  const command = parseRegistration(body.command), email = command.email.trim().toLowerCase();
  if (!await rpc("aco_rate_limit", { p_key: await hash2("register-email:" + email), p_max: 3, p_seconds: 86400 })) return { ok: true };
  if (!validBirthDate(command.birthDate || "", db.now)) throw Error("Podaj poprawn\u0105 dat\u0119 urodzenia.");
  if (command.date > dayAdd(dateOf(new Date(db.now)), rules(db).consultationDays) || !available(db, command.trainerId, command.date, command.hour) || !available(db, command.trainerId, command.date, command.hour + 1)) throw Error("Wybrany termin nie jest dost\u0119pny.");
  if (db.accounts.some((a) => a.email === email)) return { ok: true };
  if (!await rpc("aco_rate_limit", { p_key: await hash2("registration-global"), p_max: 60, p_seconds: 3600 })) throw Error("Zbyt wiele rejestracji. Spr\xF3buj ponownie p\xF3\u017Aniej.");
  await registerAccount(db, command);
  const user = await auth("/admin/users", "POST", { email, password: crypto.randomUUID() + crypto.randomUUID(), email_confirm: false });
  const userId = user.id;
  if (typeof userId !== "string") throw Error("Nie uda\u0142o si\u0119 utworzy\u0107 konta.");
  let committed = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) {
        snapshot = await rpc("aco_relational_public_load", { p_email: email });
        db = decodeRelational(snapshot);
      }
      const result = await registerAccount(db, command), next = result.db, client = next.clients.at(-1);
      const account = next.accounts.find((a) => a.clientId === client.id);
      account.id = userId;
      for (const session of next.sessions) if (session.clientId === client.id && session.kind === "consultation") session.consultationPrice = db.settings.consultation;
      next.sales = next.sales.filter((s) => s.clientId !== client.id);
      const delta = relationalCommitArgs(db, next, userId, "register");
      try {
        await rpc("aco_relational_commit", { p_actor: userId, p_session: null, p_request: body.requestId, p_hash: await hash2(JSON.stringify(command)), ...delta });
        committed = true;
        return { ok: true };
      } catch (error) {
        if (error.code === "40001" && attempt < 2) continue;
        throw error;
      }
    }
  } finally {
    if (!committed) {
    }
  }
  throw Error("Nie uda\u0142o si\u0119 zarezerwowa\u0107 konsultacji.");
}
async function trainerAction(db, body, userId, services) {
  const me = db.accounts.find((a) => a.id === userId && !a.disabled);
  if (me?.role !== "admin" || me.mustChangePassword) throw Error("Brak uprawnie\u0144 administratora.");
  const input = parseTrainer(body.input);
  if (!input.id && input.password.length < 12) throw Error("Has\u0142o musi mie\u0107 co najmniej 12 znak\xF3w.");
  const old = input.id ? db.accounts.find((a) => a.trainerId === input.id) : void 0;
  if (old && input.email.trim().toLowerCase() !== old.email) throw Error("Zmian\u0119 adresu e-mail potwierdza w\u0142a\u015Bciciel konta.");
  const next = await addTrainer(db, actorFor(me), input);
  const trainer = next.trainers.find((t) => t.id === (input.id || next.trainers.at(-1).id));
  const account = next.accounts.find((a) => a.trainerId === trainer.id);
  if (!old) {
    const user = await services.auth("/admin/users", "POST", { email: account.email, password: input.password, email_confirm: true });
    account.id = user.id;
  }
  delete account.password;
  delete account.token;
  return next;
}
function finishActivation(db, userId) {
  const me = db.accounts.find((a) => a.id === userId && !a.disabled), client = db.clients.find((c) => c.id === me?.clientId);
  if (me?.role !== "client" || !client?.invited || !client.prescribed) throw Error("Konto oczekuje na zatwierdzenie konsultacji.");
  return execute(db, actorFor(me), { type: "acceptInvite", id: client.id });
}

// server/handler.ts
var ApiError = class extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
};
var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var hash = async (v) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))), (b) => b.toString(16).padStart(2, "0")).join("");
function createHandler(config, fetcher = fetch) {
  async function rpc(name, args) {
    const result = await fetcher(config.url + "/rest/v1/rpc/" + name, { method: "POST", headers: { apikey: config.serviceKey, Authorization: "Bearer " + config.serviceKey, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    const data = await result.json();
    if (!result.ok) throw new ApiError(data.code === "40001" ? 409 : 403, "Nie uda\u0142o si\u0119 zapisa\u0107 operacji.", data.code);
    return data;
  }
  async function auth(path, method, body, token) {
    const response = await fetcher(config.url + "/auth/v1" + path, { method, headers: { apikey: config.serviceKey, Authorization: "Bearer " + (token || config.serviceKey), "Content-Type": "application/json" }, ...body ? { body: JSON.stringify(body) } : {} });
    if (!response.ok) throw new ApiError(422, "Nie uda\u0142o si\u0119 zapisa\u0107 danych konta.");
    return response.status === 204 ? {} : response.json();
  }
  const services = { rpc, auth, hash };
  async function authenticate(req) {
    const authorization = req.headers.get("Authorization") || "";
    if (!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization) || authorization.length > 1e4) throw new ApiError(401, "Zaloguj si\u0119 ponownie.");
    const response = await fetcher(config.url + "/auth/v1/user", { headers: { apikey: config.serviceKey, Authorization: authorization } });
    if (!response.ok) throw new ApiError(401, "Zaloguj si\u0119 ponownie.");
    const user = await response.json();
    let claims;
    try {
      claims = JSON.parse(atob(authorization.slice(7).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      throw new ApiError(401, "Zaloguj si\u0119 ponownie.");
    }
    if (!uuid.test(user.id) || claims.sub !== user.id || !uuid.test(claims.session_id)) throw new ApiError(401, "Zaloguj si\u0119 ponownie.");
    return { id: user.id, sessionId: claims.session_id, email: user.email_confirmed_at ? user.email : void 0 };
  }
  return async function handle(req) {
    const origin = req.headers.get("Origin");
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin", "X-Content-Type-Options": "nosniff" };
    if (origin && !config.origins.includes(origin)) return new Response(JSON.stringify({ error: "Niedozwolone \u017Ar\xF3d\u0142o \u017C\u0105dania." }), { status: 403, headers });
    if (origin) headers["Access-Control-Allow-Origin"] = origin;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Max-Age": "600" } });
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (req.method !== "POST") return reply({ error: "Nieobs\u0142ugiwana metoda." }, 405);
    try {
      if (Number(req.headers.get("Content-Length")) > 3e6) throw new ApiError(413, "Formularz jest zbyt du\u017Cy.");
      const reader = req.body?.getReader();
      if (!reader) throw new ApiError(400, "Brak formularza.");
      let size = 0;
      const chunks = [];
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 3e6) {
          await reader.cancel();
          throw new ApiError(413, "Formularz jest zbyt du\u017Cy.");
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      let body;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new ApiError(400, "Nieprawid\u0142owy formularz.");
      }
      const allowed = { state: [], quote: ["id", "code"], command: ["requestId", "command"], publicState: [], register: ["requestId", "command"], activation: ["email", "birthDate"], trainer: ["requestId", "input"], resetPassword: ["requestId", "accountId"], changePassword: ["requestId", "oldPassword", "password"], finishActivation: ["requestId", "password"] };
      if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(allowed, body.action) || Object.keys(body).some((k) => k !== "action" && !allowed[body.action].includes(k))) throw new ApiError(400, "Nieprawid\u0142owe \u017C\u0105danie.");
      if (["publicState", "register", "activation"].includes(body.action)) {
        if (body.action === "register" && !uuid.test(body.requestId)) throw new ApiError(400, "Brak identyfikatora operacji.");
        try {
          return reply(await publicAction(body, req, services));
        } catch (error) {
          throw error instanceof ApiError ? error : new ApiError(422, error instanceof Error ? error.message : "Nieprawid\u0142owe dane.");
        }
      }
      const identity = await authenticate(req), mutating = !["state", "quote"].includes(body.action);
      if (mutating && !uuid.test(body.requestId)) throw new ApiError(400, "Brak identyfikatora operacji.");
      const args = { p_actor: identity.id, p_session: identity.sessionId, p_request: mutating ? body.requestId : null };
      const requestHash = mutating ? await hash(JSON.stringify(body)) : "";
      let provisionedTrainerId, passwordUpdated = false;
      const temporaryPassword = async () => {
        const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.serviceKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("aco-reset:" + identity.id + ":" + body.requestId));
        return "ACO!" + Array.from(new Uint8Array(signed), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await rpc("aco_relational_load", args), db = decodeRelational(snapshot);
        let me;
        try {
          me = body.action === "finishActivation" ? db.accounts.find((a) => a.id === identity.id && !a.disabled) : identityAccount(db, identity.id);
        } catch {
          throw new ApiError(403, "Konto nie jest aktywne lub dost\u0119p zosta\u0142 odebrany.");
        }
        if (!me) throw new ApiError(403, "Brak dost\u0119pu do konta.");
        if (identity.email && identity.email !== me.email) {
          const synced = structuredClone(db), account = synced.accounts.find((a) => a.id === me.id);
          account.email = identity.email;
          const client = synced.clients.find((c) => c.id === me.clientId);
          if (client) client.email = identity.email;
          const delta2 = relationalCommitArgs(db, synced, me.id, "emailVerified");
          try {
            await rpc("aco_relational_commit", { ...args, ...delta2, p_request: crypto.randomUUID(), p_hash: await hash("verified-email:" + identity.email) });
          } catch (error) {
            if (!(error instanceof ApiError && error.code === "40001")) throw error;
          }
          continue;
        }
        if (me.role !== snapshot.role) throw new ApiError(403, "Nieprawid\u0142owe uprawnienia konta.");
        if (me.mustChangePassword && body.action !== "changePassword") {
          if (body.action === "state") return reply({ accountId: me.id, revision: snapshot.revision, db: { ...publicState(db), accounts: [{ id: me.id, role: me.role, email: me.email, trainerId: me.trainerId, clientId: me.clientId, mustChangePassword: true }] } });
          throw new ApiError(403, "Najpierw zmie\u0144 has\u0142o tymczasowe.");
        }
        if (body.action === "quote") {
          const hold = db.holds.find((h) => h.id === body.id), client = db.clients.find((c) => c.id === hold?.clientId);
          if (!hold || !client || !canSee(db, { role: me.role, trainerId: me.trainerId || "", clientId: me.clientId || "" }, client) || typeof body.code !== "string" || body.code.length > 100) throw new ApiError(403, "Brak dost\u0119pu do rezerwacji.");
          try {
            const result = quote(db, hold.clientId, hold.service, hold.intensity, body.code);
            return reply({ base: result.base, total: result.total, percent: result.percent });
          } catch (error) {
            throw new ApiError(422, error.message);
          }
        }
        if (body.action === "state") return reply({ accountId: me.id, revision: snapshot.revision, db: projectState(db, me.id) });
        if (snapshot.receipt) {
          if (snapshot.receipt.hash !== requestHash) throw new ApiError(409, "Identyfikator wykorzystano do innej operacji.");
          return reply({ accountId: me.id, revision: snapshot.revision, db: projectState(db, me.id), replayed: true, ...body.action === "resetPassword" && me.role === "admin" ? { temporary: await temporaryPassword() } : {} });
        }
        let next;
        let extra = {};
        try {
          if (body.action === "command") {
            let command = body.command;
            if (command?.type === "updateProfile" && typeof command.email === "string" && command.email.trim().toLowerCase() !== me.email) {
              applyCommand(db, me.id, command, snapshot.now);
              await auth("/user?redirect_to=" + encodeURIComponent("https://acofitness.github.io/demo/panel.html"), "PUT", { email: command.email.trim().toLowerCase() }, req.headers.get("Authorization").slice(7));
              command = { ...command, email: me.email };
              extra = { notice: "Profil zapisany. Potwierd\u017A zmian\u0119 adresu e-mail za pomoc\u0105 otrzymanej wiadomo\u015Bci." };
            }
            next = applyCommand(db, me.id, command, snapshot.now);
          } else if (body.action === "trainer") {
            next = await trainerAction(db, body, me.id, { ...services, auth: async (path, method, input, token) => {
              if (path === "/admin/users" && method === "POST" && provisionedTrainerId) return { id: provisionedTrainerId };
              const user = await auth(path, method, input, token);
              if (path === "/admin/users" && method === "POST") provisionedTrainerId = user.id;
              return user;
            } });
          } else if (body.action === "resetPassword") {
            if (me.role !== "admin") throw Error("Brak uprawnie\u0144 administratora.");
            const target = db.accounts.find((a) => a.id === body.accountId && !a.disabled);
            if (!target || target.id === me.id) throw Error("Wybierz inne aktywne konto.");
            const temporary = await temporaryPassword();
            await rpc("aco_revoke_sessions", { p_target: target.id });
            await auth("/admin/users/" + target.id, "PUT", { password: temporary });
            next = structuredClone(db);
            next.accounts.find((a) => a.id === target.id).mustChangePassword = true;
            extra = { temporary };
          } else if (body.action === "changePassword" || body.action === "finishActivation") {
            if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 200) throw Error("Has\u0142o musi mie\u0107 od 12 do 200 znak\xF3w.");
            if (body.action === "changePassword" && !passwordUpdated) {
              if (typeof body.oldPassword !== "string" || body.oldPassword === body.password) throw Error("Wpisz inne has\u0142o ni\u017C dotychczasowe.");
              try {
                await auth("/token?grant_type=password", "POST", { email: me.email, password: body.oldPassword });
              } catch {
                await auth("/token?grant_type=password", "POST", { email: me.email, password: body.password });
              }
            }
            next = body.action === "finishActivation" ? finishActivation(db, me.id) : structuredClone(db);
            if (!passwordUpdated) {
              await auth("/user", "PUT", { password: body.password }, req.headers.get("Authorization").slice(7));
              passwordUpdated = true;
            }
            next.accounts.find((a) => a.id === me.id).mustChangePassword = false;
          } else throw Error("Nieznana operacja.");
        } catch (error) {
          throw error instanceof ApiError ? error : new ApiError(422, error instanceof Error ? error.message : "Nieprawid\u0142owa operacja.");
        }
        const delta = relationalCommitArgs(db, next, me.id, body.action === "command" ? body.command.type : body.action);
        try {
          const result = await rpc("aco_relational_commit", { ...args, ...delta, p_hash: requestHash });
          return reply({ accountId: me.id, revision: result.revision, db: projectState(next, me.id), ...extra });
        } catch (error) {
          if (error instanceof ApiError && error.code === "40001" && attempt < 2) continue;
          throw error;
        }
      }
      throw new ApiError(409, "Grafik zosta\u0142 zmieniony. Od\u015Bwie\u017C go i spr\xF3buj ponownie.");
    } catch (error) {
      return reply({ error: error instanceof ApiError ? error.message : "Nie uda\u0142o si\u0119 obs\u0142u\u017Cy\u0107 \u017C\u0105dania." }, error instanceof ApiError ? error.status : 500);
    }
  };
}

// supabase/functions/aco-api/entry.ts
var url = Deno.env.get("SUPABASE_URL");
var serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !serviceKey) throw Error("Missing server configuration");
Deno.serve(createHandler({ url, serviceKey, origins: ["https://acofitness.github.io"] }));
