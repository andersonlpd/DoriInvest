import {S, persist} from '../store.js';
import {money, notify} from '../dom.js';
import {totals} from '../calc.js';

const uid = () => globalThis.crypto?.randomUUID?.() || String(Date.now() + Math.random());

function monthlyIncome() {
  const now = new Date(),
    months = [];
  for (let i = 11; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0'));
  }
  const total = S.transactions.filter(t => t.type === 'Provento' && t.date && months.includes(String(t.date).slice(0, 7))).reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  return total / 12;
}

function currentFor(type) {
  if (type === 'renda') return monthlyIncome();
  return totals(S.positions.filter(p => p.quantity > 0)).market;
}

function goalRow(goal) {
  const current = currentFor(goal.type),
    pct = goal.target > 0 ? Math.min(100, current / goal.target * 100) : 0,
    item = document.createElement('div');
  item.className = 'goal-item card';
  const head = document.createElement('div');
  head.className = 'goal-item-head';
  const info = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = goal.title;
  const kind = document.createElement('small');
  kind.textContent = goal.type === 'renda' ? 'Renda mensal desejada' : 'Patrimônio desejado';
  info.append(title, kind);
  const percent = document.createElement('b');
  percent.textContent = pct.toLocaleString('pt-BR', {maximumFractionDigits: 1}) + '%';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'text-link';
  remove.dataset.goalRemove = goal.id;
  remove.textContent = 'Remover';
  head.append(info, percent, remove);
  const track = document.createElement('div');
  track.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = pct + '%';
  track.append(fill);
  const foot = document.createElement('div');
  foot.className = 'goal-foot';
  const now = document.createElement('span');
  now.textContent = (goal.type === 'renda' ? money(current) + '/mês' : money(current)) + ' de ' + money(goal.target);
  const missing = document.createElement('span');
  missing.textContent = current >= goal.target ? 'Meta atingida' : 'Faltam ' + money(goal.target - current);
  foot.append(now, missing);
  item.append(head, track, foot);
  return item;
}

function renderGoals() {
  const list = document.getElementById('goal-list'),
    empty = document.getElementById('goal-empty');
  if (!list) return;
  list.replaceChildren();
  empty.hidden = !!S.goals.length;
  S.goals.forEach(goal => list.append(goalRow(goal)));
}

function openGoalForm() {
  const card = document.getElementById('goal-form-card');
  document.getElementById('goal-form').reset();
  card.hidden = false;
  document.getElementById('goal-title').focus();
}

const list = document.getElementById('goal-list');

document.getElementById('goal-add')?.addEventListener('click', openGoalForm);
document.getElementById('goal-cancel')?.addEventListener('click', () => {
  document.getElementById('goal-form-card').hidden = true;
});
list?.addEventListener('click', event => {
  const button = event.target.closest('[data-goal-remove]');
  if (!button) return;
  S.goals = S.goals.filter(goal => goal.id !== button.dataset.goalRemove);
  persist();
  renderGoals();
  notify('Meta removida.');
});

document.getElementById('goal-form')?.addEventListener('submit', event => {
  event.preventDefault();
  const title = document.getElementById('goal-title').value.trim() || 'Minha meta',
    type = document.getElementById('goal-type').value,
    target = Number(document.getElementById('goal-target').value);
  if (!Number.isFinite(target) || target <= 0) return notify('Informe um valor alvo maior que zero.');
  S.goals = [...S.goals, {id: uid(), title: title.slice(0, 60), type: type === 'renda' ? 'renda' : 'patrimonio', target, createdAt: new Date().toISOString()}].slice(-20);
  if (!persist()) return;
  document.getElementById('goal-form-card').hidden = true;
  renderGoals();
  notify('Meta salva.');
});

export {renderGoals, monthlyIncome, currentFor};
