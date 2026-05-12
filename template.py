#!/usr/bin/env python3

## Default executable of a SAT solver (do not change this)
defSATsolver="z3"

## Change this to an executable SAT solver if z3 is not in your PATH or else
## Example (Linux): SATsolver="/home/user/z3-4.13/bin/z3"
## You can also include command-line options if necessary
SATsolver=defSATsolver

import sys
from subprocess import Popen
from subprocess import PIPE
import re
import random
import os
import shutil

gVarNumberToName = ["invalid"]
gVarNameToNumber = {}

def closed_range(start, stop, step=1):
    dir = 1 if (step > 0) else -1
    return range(start, stop + dir, step)

def varCount():
    global gVarNumberToName
    return len(gVarNumberToName) - 1

def allVarNumbers():
    return closed_range(1, varCount())

def varNumberToName(num):
    global gVarNumberToName
    return gVarNumberToName[num]

def varNameToNumber(name):
    global gVarNameToNumber
    return gVarNameToNumber[name]

def addVarName(name):
    global gVarNumberToName
    global gVarNameToNumber
    gVarNumberToName.append(name)
    gVarNameToNumber[name] = varCount()

# def printClause(clause):
#     print(map(lambda x: "%s%s" % (x < 0 and eval("'-'") or eval ("''"), varNumberToName(abs(x))) , clause))

def getVarNumber(**kwargs):
    return varNameToNumber(getVarName(**kwargs))

def getVarName(**kwargs):
    r = kwargs['r']
    c = kwargs['c']
    n = kwargs['n']
    return "X(%d,%d,%d)" % (r, c, n)


def genVarNames(**kwargs):
    for r in closed_range(1, 9):
        for c in closed_range(1, 9):
            for n in closed_range(1, 9):
                addVarName(getVarName(r=r, c=c, n=n))

def genClauses(**kwargs):
    clauses = []

    #Every cell has at least one number
    for r in closed_range(1, 9):
        for c in closed_range(1, 9):
            clause = []
            for n in closed_range(1, 9):
                clause.append(getVarNumber(r=r,c=c,n=n))
            clauses.append(clause)

    #Every cell has at most one number -> not X(r,c,n1) or not X(r,c,n2)
    for r in closed_range(1, 9):
        for c in closed_range(1, 9):
            for n1 in closed_range(1, 9):
                #start to n1 + 1 avoids duplicate clauses
                for n2 in closed_range(n1 + 1, 9):
                    clauses.append([
                        -getVarNumber(r=r,c=c,n=n1),
                        -getVarNumber(r=r,c=c,n=n2),
                    ])

    #No number may appear two times in the same row
    for r in closed_range(1, 9):
        for n in closed_range(1, 9):
            for c1 in closed_range(1, 9):
                for c2 in closed_range(c1 + 1, 9):
                    clauses.append([
                        -getVarNumber(r=r,c=c1,n=n),
                        -getVarNumber(r=r,c=c2,n=n),
                    ])

    #No number may appear two times in the same column
    for c in closed_range(1, 9):
        for n in closed_range(1, 9):
            for r1 in closed_range(1, 9):
                for r2 in closed_range(r1 + 1, 9):
                    clauses.append([
                        -getVarNumber(r=r1,c=c,n=n),
                        -getVarNumber(r=r2,c=c,n=n),
                    ])

    #No number may appear two times in the same box
    for br in [1,4,7]:
        for bc in [1,4,7]:
            cells = []
            for r in range(br, br + 3):
                for c in range(bc, bc + 3):
                    cells.append((r,c))

            for n in closed_range(1, 9):
                for i in range(len(cells)):
                    for j in range(i + 1, len(cells)):
                        r1, c1 = cells[i]
                        r2, c2 = cells[j]
                        clauses.append([
                            -getVarNumber(r=r1,c=c1,n=n),
                            -getVarNumber(r=r2,c=c2,n=n),
                        ])

    #There are some input numbers. We can use 0 for emtpy cells.
    grid = kwargs['grid']
    for r in closed_range(1, 9):
        for c in closed_range(1, 9):
            value = grid[r-1][c-1]
            if value != 0:
                clauses.append([
                    getVarNumber(r=r,c=c,n=value),
                ])


    return clauses

## A helper function to print the cnf header (do not modify)
def getDimacsHeader(clauses):
    cnt = varCount()
    n = len(clauses)
    str = ""
    for num in allVarNumbers():
        varName = varNumberToName(num)
        str += "c %d ~ %s\n" % (num, varName)
    for cl in clauses:
        print("c ", end='')
        for l in cl:
            print(("!" if (l < 0) else " ") + varNumberToName(abs(l)), "", end='')
        print("")
    print("")
    str += "p cnf %d %d" % (cnt, n)
    return str

## A helper function to print a set of clauses in CNF (do not modify)
def toDimacsCnf(clauses):
    return "\n".join(map(lambda x: "%s 0" % " ".join(map(str, x)), clauses))

## A helper function to print only the satisfied variables in human-readable format (do not modify)
def printResult(res):
    print(res)
    res = res.strip().split('\n')

    # If it was satisfiable, we want to have the assignment printed out
    if res[0] != "s SATISFIABLE":
        return

    # First get the assignment, which is on the second line of the file, and split it on spaces
    # Read the solution
    asgn = map(int, res[1].split()[1:])
    # Then get the variables that are positive, and get their names.
    # This way we know that everything not printed is false.
    # The last element in asgn is the trailing zero and we can ignore it

    # Convert the solution to our names
    facts = map(lambda x: varNumberToName(abs(x)), filter(lambda x: x > 0, asgn))

    # Print the solution
    print("c SOLUTION:")
    for f in facts:
        print("c", f)

def genSolvedBoard(res,filename):
    res = res.strip().split('\n')

    if res[0] != "s SATISFIABLE":
        return

    asgn = map(int, res[1].split()[1:])
    facts = [
        tuple(map(int, re.findall(r'\d+', varNumberToName(x))))
        for x in asgn
        if x > 0
    ]

    with open(filename, 'w') as f:
        for i in range(9):
            for j in range(9):
                f.write(f"{facts[9 * i + j][2]}")
            f.write("\n")



## This function is invoked when the python script is run directly and not imported
if __name__ == '__main__':
    path = shutil.which(SATsolver.split()[0])
    if path is None:
        if SATsolver == defSATsolver:
            print("Set the path to a SAT solver via SATsolver variable on line 9 of this file (%s)" % sys.argv[0])
        else:
            print("Path '%s' does not exist or is not executable." % SATsolver)
        sys.exit(1)

    kwargs = {}

    ##+ Insert here the code to read the arguments of your application and fill them into 'kwargs'
    # example:
    # if len(sys.argv) != 2:
    #     print("Usage: %s <count>" % sys.argv[0])
    #     sys.exit(1)

    # kwargs['count'] = int(sys.argv[1])
    ##+ End of code insertion

    ###adding down here###
    if len(sys.argv) != 3:
        print("Usage: %s <sudoku_input_file>" % sys.argv[0])
        sys.exit(1)

    input_filename = sys.argv[1]
    output_filename = sys.argv[2]
    grid = []
    with open(input_filename, 'r') as f:
        for line in f:
            line = line.strip()
            row = [int(x) for x in line]
            grid.append(row)
    kwargs['grid'] = grid
    ###adding up here###

    genVarNames(**kwargs)
    clauses = genClauses(**kwargs)

    head = getDimacsHeader(clauses)
    cnf = toDimacsCnf(clauses)

    # Here we create a temporary cnf file for SATsolver
    fl = open("tmp_prob.cnf", "w")
    fl.write("\n".join([head, cnf]) + "\n")
    fl.close()

    # Run the SATsolver
    solverOutput = Popen([SATsolver + " tmp_prob.cnf"], stdout=PIPE, shell=True).communicate()[0]
    res = solverOutput.decode('utf-8')
    printResult(res)
    genSolvedBoard(res,output_filename)