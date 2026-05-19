const grid = document.getElementById("grid");
const matrix = document.getElementById("matrix");
const statusText = document.getElementById("status");
const clearButton = document.getElementById("clear");
const solveButton = document.getElementById("solve");

const cells = [];

for (let row = 0; row < 9; row++) {
  cells[row] = [];

  for (let col = 0; col < 9; col++) {
    const input = document.createElement("input");

    input.type = "text";
    input.maxLength = 1;
    input.className = "cell";
    input.inputMode = "numeric";

    if (col === 2 || col === 5) {
      input.classList.add("right");
    }

    if (row === 2 || row === 5) {
      input.classList.add("bottom");
    }

    input.addEventListener("input", () => {
      input.value = input.value.replace(/[^1-9]/g, "");
      statusText.textContent = "";
    });

    grid.appendChild(input);
    cells[row][col] = input;
  }
}

function setGrid(text) {
  const rows = text.trim() ? text.trim().split(/\s+/) : [];

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const value = rows[row] && rows[row][col] ? rows[row][col] : "0";
      cells[row][col].value = value === "0" ? "" : value;
    }
  }
}

function validMatrix(text) {
  const rows = text.trim().split(/\s+/);

  if (rows.length !== 9) {
    return false;
  }

  for (let i = 0; i < 9; i++) {
    if (!/^[0-9]{9}$/.test(rows[i])) {
      return false;
    }
  }

  return true;
}

matrix.addEventListener("input", () => {
  const text = matrix.value.trim();

  if (text === "") {
    statusText.textContent = "";
    return;
  }

  if (validMatrix(text)) {
    setGrid(text);
    statusText.textContent = "Matrice importata.";
  }
});

clearButton.addEventListener("click", () => {
  setGrid("");
  matrix.value = "";
  statusText.textContent = "Griglia pulita.";
});

solveButton.addEventListener("click", () => {
  statusText.textContent = "Solve non disponibile.";
});
